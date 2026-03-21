// Harness: context isolation -- protecting the model's clarity of thought.
// s04_subagent - Subagents

// 生成一个子代理，其消息列表初始化为空（messages=[]）。该子代理在独立的上下文中运行，共享文件系统，随后仅向父代理返回一份摘要。

//     Parent agent                     Subagent
//     +------------------+             +------------------+
//     | messages=[...]   |             | messages=[]      |  <-- fresh
//     |                  |  dispatch   |                  |
//     | tool: task       | ---------->| while tool_use:  |
//     |   prompt="..."   |            |   call tools     |
//     |   description="" |            |   append results |
//     |                  |  summary   |                  |
//     |   result = "..." | <--------- | return last text |
//     +------------------+             +------------------+
//               |
// 父代理的上下文保持洁净。
// 子代理的上下文将被丢弃。
// 核心见解：“进程隔离天然地提供了上下文隔离。

import path from "node:path";

import * as Bun from "bun";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources";
import { client } from "./provider";

const WORKDIR = process.cwd();

const system = `您是 ${WORKDIR} 的一名编码员。请使用待办事项工具规划多步骤任务。开始前标记为“进行中”，完成后标记为“已完成”。建议优先使用工具而非文字描述。`;

const subagentSystem = `你是在 ${WORKDIR} 的编码子代理。请完成给定任务，然后总结你的发现。`;

const regx = /\r?\n/;

// 父子工具共享的实现
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
    return `run bash Error: ${error}`;
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
    return `run read Error: ${error}`;
  }
}

async function runWrite({ path: p, content }: { path: string; content: string }) {
  try {
    const safePathStr = safePath(p);
    await Bun.write(safePathStr, content);
    return `已向 ${safePathStr} 写入 ${content.length} 字符`;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return `run write Error: ${error}`;
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
    return `run edit Error: ${error}`;
  }
}

// -- The dispatch map: {tool_name: handler} --
const toolHandlers = {
  bash: runBash,
  readFile: runRead,
  writeFile: runWrite,
  editFile: runEdit,
};

const childTools: ChatCompletionTool[] = [
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

// 子代理：提供最新上下文、筛选工具，仅返回摘要

async function runSubagent(prompt: string) {
  const subMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: subagentSystem },
    { role: "user", content: prompt },
  ];
  let textBlocks = "";
  for (let i = 0; i < 30; i++) {
    const response = await client.chat.completions.create({
      model: "qwen3.5-plus",
      messages: subMessages,
      tools: childTools,
    });
    const choice = response.choices[0];
    if (!choice) {
      throw new Error("模型未返回任何选项");
    }
    const { message } = choice;
    subMessages.push({
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls,
    });
    if (!message.tool_calls?.length) {
      textBlocks = choice.message.content ?? "";
      break;
    }

    console.log(
      `调用工具: ${message.tool_calls
        .filter((v) => v.type === "function")
        .map((v) => v.function.name)
        .join(", ")}`
    );
    for (const toolCall of message.tool_calls) {
      let content = "";
      if (toolCall.type === "function") {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          const handler = toolHandlers[toolCall.function.name as keyof typeof toolHandlers];
          if (!handler) {
            throw new Error(`未知工具 ${toolCall.function.name}`);
          }

          console.log(`[tool] 执行 ${toolCall.function.name}。`);

          content = await handler(args);
          console.log(`[tool] ${toolCall.function.name} 结果：${content}`);
        } catch (e) {
          content = `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
        subMessages.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
    }
  }
  return textBlocks;
}

const parentTools: ChatCompletionTool[] = [
  ...childTools,
  {
    type: "function",
    function: {
      name: "task",
      description: "生成一个具有全新上下文的子代理。它共享文件系统，但不共享对话历史记录。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          description: { type: "string", description: "任务简述" },
        },
        required: ["prompt"],
      },
    },
  },
];

async function agentLoop(messages: ChatCompletionMessageParam[]) {
  while (true) {
    const response = await client.chat.completions.create({
      model: "qwen3.5-plus",
      messages: [{ role: "system", content: system }, ...messages],
      tools: parentTools,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("模型未返回任何选项");
    }
    const { message } = choice;
    messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls });
    if (!message.tool_calls?.length) {
      return messages;
    }

    console.log(
      `调用工具: ${message.tool_calls
        .filter((v) => v.type === "function")
        .map((v) => v.function.name)
        .join(", ")}`
    );
    for (const toolCall of message.tool_calls) {
      let content = "";
      if (toolCall.type === "function") {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          console.log(`[tool] 执行 ${toolCall.function.name}。`);

          if (toolCall.function.name === "task") {
            content = await runSubagent(args);
          } else {
            const handler = toolHandlers[toolCall.function.name as keyof typeof toolHandlers];
            if (!handler) {
              throw new Error(`未知工具 ${toolCall.function.name}`);
            }
            content = await handler(args);
          }

          console.log(`[tool] ${toolCall.function.name} 结果：${content}`);
        } catch (e) {
          content = `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
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
  await Bun.write("result.json", JSON.stringify(result, null, 2));
  console.log("完成");
}

// 1. 使用子任务查找此项目使用的测试框架。
// 2. 委托：读取所有 .py 文件并总结每个文件的功能。
// 3. 使用任务创建一个新模块，然后从此处验证它。
