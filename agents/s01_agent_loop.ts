// s01_agent_loop - 代理循环
// AI 编码代理的核心秘密就是一个模式：
//     while stop_reason == "tool_use":
//         response = LLM(messages, tools)
//         execute tools
//         append results

//     +----------+     +-------+      +---------+
//     |   用户   | ---> |  LLM  | ---> |  工具   |
//     |   输入   |      |       |      |   执行  |
//     +----------+     +---+---+      +----+----+
//                            ^               |
//                            |   tool_result |
//                            +---------------+
//                            (循环继续)
// 这就是核心循环：将工具结果反馈给模型，
// 直到模型决定停止。生产环境的代理会在此基础上
// 添加策略、钩子和生命周期控制。

import * as Bun from "bun";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources";
import { client } from "./provider";

const WORKDIR = process.cwd();

const system = `你是一个位于 ${WORKDIR} 的编程代理。使用 bash 来完成任务。行动,不要解释。`;

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
];

async function runBash(command: string) {
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

    for (const toolCall of message.tool_calls) {
      if (toolCall.type === "function") {
        const tc = toolCall;
        const args = JSON.parse(tc.function.arguments);
        console.log(`[tool] ${tc.function.name}: ${args.command}`);
        const content = await runBash(args.command);
        messages.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
    }
  }
}

console.log("请输入内容后按回车...");
for await (const chunk of Bun.stdin.stream()) {
  const chunkText = Buffer.from(chunk).toString();
  console.log(`[user]: ${chunkText}`);

  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: chunkText }];
  const res = await agentLoop(messages);
  await Bun.write("result.json", JSON.stringify(res, null, 2));
  console.log("完成");
}

// 1. 创建一个名为 hello.py 的文件，并打印“Hello, World!”。
// 2. 列出此目录中的所有 Python 文件。
// 3. 当前 git 分支是什么？
// 4. 创建一个名为 test_output 的目录，并在其中写入 3 个文件。
