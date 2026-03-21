// 工具调度器：扩展模型可以触及的范围。
// s02_tool_use.py - 工具

// s01 的代理循环没有改变。我们只是向数组添加了工具
// 并添加了一个调度映射来路由调用。

//     +----------+      +-------+     +------------------+
//     |   用户   | ---> |  LLM  | ---> | 工具调度        |
//     |   输入   |      |       |      | {                |
//     +----------+      +---+---+      |   bash: run_bash |
//                           ^          |   read: run_read |
//                           |          |   write: run_wr |
//                           +----------+   edit: run_edit |
//                           tool_result| }                |
//                                      +------------------+
// 关键洞察："循环完全没有改变。我只是添加了工具。"

import path from "node:path";

import * as Bun from "bun";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources";
import { client } from "./provider";

const WORKDIR = process.cwd();

const system = `你是位于 ${WORKDIR} 的编码代理。使用工具完成任务。直接执行，不要解释。`;

const regx = /\r?\n/;

function safePath(p: string) {
  const safe = path.resolve(WORKDIR, p);
  if (!safe.startsWith(WORKDIR)) {
    throw new Error("该路径超出了当前工作目录范围");
  }
  return safe;
}

async function runBash({ command }: { command: string }) {
  try {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
      throw new Error("命令包含危险操作");
    }

    const isWindows = process.platform === "win32";
    const proc = Bun.spawn({
      cmd: isWindows ? ["cmd", "/c", command] : ["sh", "-c", command],
      cwd: WORKDIR,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const err = await new Response(proc.stderr).text();
    if (err) {
      throw new Error(err);
    }

    const out = await new Response(proc.stdout).text();
    return out || "shell 执行完毕";
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return `Error: ${error}`;
  }
}

async function runRead({ path: p, limit }: { path: string; limit?: number }) {
  try {
    const text = await Bun.file(safePath(p)).text();
    let lines = text.split(regx);
    if (limit && lines.length > limit) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }

    return lines.join("\n").slice(0, 50_000);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return `Error: ${error}`;
  }
}

async function runWrite({ path: p, content }: { path: string; content: string }) {
  try {
    const safePathStr = safePath(p);
    await Bun.write(safePathStr, content);
    return `已向 ${safePathStr} 写入 ${content.length} 字符`;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return `Error: ${error}`;
  }
}

async function runEdit({
  path: p,
  oldText,
  newText,
}: {
  path: string;
  oldText: string;
  newText: string;
}) {
  try {
    const safePathStr = safePath(p);
    const file = Bun.file(safePathStr);
    if (!(await file.exists())) {
      throw new Error(`文件 ${safePathStr} 不存在`);
    }
    const content = await file.text();
    if (!content.includes(oldText)) {
      throw new Error(`文件 ${safePathStr} 中未找到旧文本`);
    }
    const updatedContent = content.replace(oldText, newText);
    await Bun.write(safePathStr, updatedContent);
    return `编辑完成 ${safePathStr}`;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return `Error: ${error}`;
  }
}

// -- The dispatch map: {tool_name: handler} --
const toolHandlers = {
  bash: runBash,
  readFile: runRead,
  writeFile: runWrite,
  editFile: runEdit,
};

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "执行 shell 命令。",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "readFile",
      description: "读取文件内容。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "writeFile",
      description: "将内容写入文件。",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editFile",
      description: "替换文件中的精确文本。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["path", "oldText", "newText"],
      },
    },
  },
];

async function agentLoop(messages: ChatCompletionMessageParam[]) {
  while (true) {
    const response = await client.chat.completions.create({
      model: "qwen3.5-plus",
      messages: [{ role: "system", content: system }, ...messages],
      tools,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("模型未返回任何选项");
    }
    const { message } = choice;
    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls,
    });
    if (!message.tool_calls?.length) {
      return messages;
    }

    console.log(`[assistant] 调用工具：${JSON.stringify(message.tool_calls, null, 2)}`);
    for (const toolCall of message.tool_calls) {
      if (toolCall.type === "function") {
        const args = JSON.parse(toolCall.function.arguments);
        const handler = toolHandlers[toolCall.function.name as keyof typeof toolHandlers];
        if (!handler) {
          console.log(`[tool] 未找到工具：${toolCall.function.name}`);
          continue;
        }
        console.log(`[tool] 执行 ${toolCall.function.name}，参数 ${JSON.stringify(args, null, 2)}`);
        const content = await handler(args);

        console.log(
          `[tool] 返回 ${toolCall.function.name}，结果 ${JSON.stringify(content, null, 2)}`
        );
        messages.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
    }
  }
}

console.log(`工作目录：${WORKDIR}`);
console.log("请输入内容后按回车...");
for await (const chunk of Bun.stdin.stream()) {
  const chunkText = Buffer.from(chunk).toString();
  console.log(`[user]: ${chunkText}`);

  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: chunkText }];
  const result = await agentLoop(messages);
  console.log(JSON.stringify(result, null, 2));
  console.log("完成");
}
