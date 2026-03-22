// Harness: 压缩——为无限会话清理内存。
// s06_context_compact - 压缩

// 三层压缩管道，让代理可以永久工作：

//     每一轮：
//     +------------------+
//     | 工具调用结果       |
//     +------------------+
//             |
//             v
//     [第一层：micro_compact]        （静默，每轮执行）
//       将最近 3 条之前的 tool_result 内容
//       替换为 "[Previous: used {tool_name}]"
//             |
//             v
//     [检查：tokens > 50000?]
//        |               |
//        否              是
//        |               |
//        v               v
//       继续          [第二层：auto_compact]
//                   将完整记录保存到 .transcripts/
//                   让 LLM 总结对话。
//                   将所有消息替换为 [summary]。
//                         |
//                         v
//                 [第三层：compact tool]
//                   模型调用 compact -> 立即总结。
//                   与自动压缩相同，但由手动触发。

// 关键见解："代理可以有策略地遗忘并持续工作。"

import fs from "node:fs";
import path from "node:path";
import * as Bun from "bun";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources";
import { client } from "./provider";

const WORKDIR = process.cwd();
const SYSTEM = `你是位于 ${WORKDIR} 的编码代理。请使用工具来完成任务。`;
// 阈值
const THRESHOLD = 50_000;
// 转录目录
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
// 保留最近的消息数
const KEEP_RECENT = 3;
const LINE_REGX = /\r?\n/;

function estimateTokens(messages: ChatCompletionMessageParam[]) {
  // 粗略的 token 计数：每个 token 约 4 个字符。
  return Math.ceil(JSON.stringify(messages).length / 4);
}

// -- 第 1 层：micro_compact - 用占位符替换旧的工具结果 --
function microCompact(messages: ChatCompletionMessageParam[]) {
  const toolResultMessages: ChatCompletionMessageParam[] = [];
  const toolNameMap: Record<string, string> = {};

  for (const msg of messages) {
    if (msg.role === "tool") {
      toolResultMessages.push(msg);
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        if (toolCall.type === "function") {
          toolNameMap[toolCall.id] = toolCall.function.name;
        }
      }
    }
  }

  if (toolResultMessages.length <= KEEP_RECENT) {
    return messages;
  }

  for (const msg of toolResultMessages.slice(0, -KEEP_RECENT)) {
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > 100) {
      msg.content = `[Previous: used ${toolNameMap[msg.tool_call_id]}]`;
    }
  }
  return messages;
}

// -- 第 2 层：auto_compact - 保存对话记录，生成摘要，并替换原始消息列表 --
async function autoCompact(messages: ChatCompletionMessageParam[]) {
  fs.mkdirSync(TRANSCRIPT_DIR);
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(transcriptPath, JSON.stringify(messages, null, 2));
  console.log(`[transcript saved: ${transcriptPath}]`);
  const conversationText = JSON.stringify(messages).slice(0, 80_000);
  const response = await client.completions.create({
    model: "qwen3.5-plus",
    prompt: conversationText,
    max_tokens: 2000,
  });
  const summary = response.choices[0]?.text;
  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    { role: "assistant", content: "Understood. I have the context from the summary. Continuing." },
  ] as ChatCompletionMessageParam[];
}

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
    let lines = text.split(LINE_REGX);
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
  compact: () => "Manual compression requested.",
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
  {
    type: "function",
    function: {
      name: "compact",
      description: "Trigger manual conversation compression.",
      parameters: {
        type: "object",
        properties: { focus: { type: "string", description: "What to preserve in the summary" } },
        required: ["focus"],
      },
    },
  },
];

async function agentLoop(_messages: ChatCompletionMessageParam[]) {
  while (true) {
    let messages = [..._messages];
    // 第 1 层：在每次调用大语言模型（LLM）之前执行 micro_compact（微压缩）
    microCompact(messages);
    // 第 2 层：如果估算的 token 数量超过阈值，则执行 auto_compact（自动压缩）
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      messages = await autoCompact(messages);
    }
    const response = await client.chat.completions.create({
      model: "qwen3.5-plus",
      messages: [{ role: "system", content: SYSTEM }, ...messages],
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

if (import.meta.main) {
  console.log("请输入内容后按回车...");
  for await (const chunk of Bun.stdin.stream()) {
    const chunkText = Buffer.from(chunk).toString();
    console.log(`[user]: ${chunkText}`);
    const messages: ChatCompletionMessageParam[] = [{ role: "user", content: chunkText }];
    const result = await agentLoop(messages);
    console.log(JSON.stringify(result, null, 2));
    console.log("完成");
  }
}
