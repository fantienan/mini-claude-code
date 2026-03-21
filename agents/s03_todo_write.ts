// Harness：规划——无需编写脚本即可保持模型按计划运行。
// s03_todo_write - TodoWrite
// 模型通过 TodoManager 跟踪自身的进度。烦人的提醒会强制它在忘记更新时持续更新。
//     +----------+      +-------+      +---------+
//     |   User   | ---> |  LLM  | ---> | Tools   |
//     |  prompt  |      |       |      | + todo  |
//     +----------+      +---+---+      +----+----+
//                           ^               |
//                           |   tool_result |
//                           +---------------+
//                                 |
//                     +-----------+-----------+
//                     | TodoManager state     |
//                     | [ ] task A            |
//                     | [>] task B <- doing   |
//                     | [x] task C            |
//                     +-----------------------+
//                                 |
//                     if rounds_since_todo >= 3:
//                       inject <reminder>

// 关键见解：“代理可以跟踪自己的进度——而且我可以看到它。”

import path from "node:path";
import * as Bun from "bun";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources";
import { client } from "./provider";

interface TodoItem {
  id: string;
  status: "pending" | "in_progress" | "completed";
  text: string;
}

const WORKDIR = process.cwd();

const system = `您是 ${WORKDIR} 的一名编码员。请使用待办事项工具规划多步骤任务。开始前标记为“进行中”，完成后标记为“已完成”。建议优先使用工具而非文字描述。`;

const regx = /\r?\n/;

const statusMap = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };

class TodoManager {
  items: TodoItem[];
  constructor() {
    this.items = [];
  }
  update = ({ items }: { items: TodoItem[] }) => {
    if (items.length > 20) {
      throw new Error("最多允许 20 个待办事项");
    }
    const validated: TodoItem[] = [];
    let inProgressCount = 0;
    for (const item of items) {
      const text = (item.text || "").trim();
      const status = (item.status || "pending").toLowerCase() as TodoItem["status"];
      const itemId = item.id || String(items.indexOf(item) + 1);
      if (!text) {
        throw new Error(`Item ${itemId}: text required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${itemId}: invalid status '${status}'`);
      }
      if (status === "in_progress") {
        inProgressCount++;
      }
      validated.push({ id: itemId, text, status });
    }
    if (inProgressCount > 1) {
      throw new Error("同一时间只能有一个任务处于进行中状态");
    }
    this.items = validated;
    return this.render();
  };

  render(): string {
    if (!this.items.length) {
      return "无待办项。";
    }
    const lines = this.items.map((item) => {
      return `${statusMap[item.status]} #${item.id}: ${item.text}`;
    });
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const todo = new TodoManager();

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
  todo: todo.update,
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
      name: "todo",
      description: "更新任务列表。跟踪多步骤任务的进度。",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["id", "text", "status"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
];

async function agentLoop(messages: ChatCompletionMessageParam[]) {
  let roundsSinceTodo = 0;
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
    messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls });
    if (!message.tool_calls?.length) {
      return messages;
    }

    let usedTodo = false;
    let content = "";

    console.log(
      `调用工具: ${message.tool_calls
        .filter((v) => v.type === "function")
        .map((v) => v.function.name)
        .join(", ")}`
    );
    for (const toolCall of message.tool_calls) {
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
          if (toolCall.function.name === "todo") {
            usedTodo = true;
          }
        } catch (e) {
          content = `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
        messages.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
    }
    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;

    if (roundsSinceTodo >= 3) {
      messages.push({ role: "user", content: "<reminder>更新你的待办事项。</reminder>" });
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

/**
 *
 * 1. 重构文件 hello.py：添加类型提示、文档字符串和主程序入口保护（if __name__ == '__main__':）
 * 2. 创建一个 Python 包，包含 __init__.py、utils.py 和 tests/test_utils.py
 * 3. 审查所有 Python 文件，并修复任何代码风格问题
 */
