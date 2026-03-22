// Harness: 按需知识——领域专业知识，在模型需要时加载。
// s05_skill_loading - Skills

// 避免系统提示信息臃肿的双层技能注入：

// 第一层（低成本）：系统提示符中显示技能名称（每个技能约 100 个token）
// 第二层（按需）：工具结果中显示完整的技能描述

//     skills/
//       pdf/
//         SKILL.md          <-- frontmatter (name, description) + body
//       code-review/
//         SKILL.md

//     System prompt:
//     +--------------------------------------+
//     | You are a coding agent.              |
//     | Skills available:                    |
//     |   - pdf: Process PDF files...        |  <-- Layer 1: metadata only
//     |   - code-review: Review code...      |
//     +--------------------------------------+

//     When model calls load_skill("pdf"):
//     +--------------------------------------+
//     | tool_result:                         |
//     | <skill>                              |
//     |   Full PDF processing instructions   |  <-- Layer 2: full body
//     |   Step 1: ...                        |
//     |   Step 2: ...                        |
//     | </skill>                             |
//     +--------------------------------------+

import fs from "node:fs";
// 关键见解：“不要把所有东西都放在系统提示符里。按需加载。”
import path from "node:path";
import * as Bun from "bun";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources";
import { client } from "./provider";

interface Skill {
  body: string;
  meta: Record<string, string>;
  path: string;
}

const WORKDIR = process.cwd();
const SKILLS_DIR = path.resolve(WORKDIR, "skills");
const LINE_REGX = /\r?\n/;
const SKILL_METADATA_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

class SkillLoader {
  skillsDir: string;
  skills: Map<string, Skill> = new Map();

  constructor({ skillsDir }: { skillsDir: string }) {
    this.skillsDir = skillsDir;
    this.loadAll();
  }

  private loadAll() {
    if (!fs.existsSync(this.skillsDir)) {
      return;
    }
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(this.skillsDir, entry.name, "SKILL.md");
        if (fs.existsSync(skillPath)) {
          const skillContent = fs.readFileSync(skillPath, "utf-8");
          const { meta, body } = this.parseFrontmatter(skillContent);
          if (meta.name) {
            this.skills.set(meta.name, { meta, body, path: skillPath });
          }
        }
      }
    }
  }
  /**
   *
   * 解析 --- 分隔符之间的 YAML 前置元数据。
   */
  private parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
    const match = text.match(SKILL_METADATA_REGEX);
    if (!match?.[1]) {
      return { meta: {}, body: text.trim() };
    }
    const meta: Record<string, string> = {};
    for (const line of match[1].trim().split("\n")) {
      const idx = line.indexOf(":");
      if (idx !== -1) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        meta[key] = value;
      }
    }
    return { meta, body: match[2]?.trim() ?? "" };
  }
  /*
   * 第 1 层：系统提示符的简短描述。
   */
  getDescriptions() {
    if (!this.skills.size) {
      return "（暂无相关技能）";
    }
    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const desc = skill.meta.description ?? "暂无描述";
      const tags = skill.meta.tags ?? "";
      lines.push(`  - ${name}: ${desc}${tags ? ` [${tags}]` : ""}`);
    }
    return lines.join("\n");
  }
  /*
   * 第 2 层：工具结果中返回了完整的技能体。
   */
  getContent = ({ name }: { name: string }) => {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = Array.from(this.skills.keys()).join(", ");
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  };
}

const skillLoader = new SkillLoader({ skillsDir: SKILLS_DIR });

const SYSTEM = `你是位于 ${WORKDIR} 的编码代理。在着手处理不熟悉的话题之前，请使用 load_skill 来获取专业知识。

可用技能：
${skillLoader.getDescriptions()}`;

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
  loadSkill: skillLoader.getContent,
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
      name: "loadSkill",
      description: "名称加载专业知识。",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "要加载的技能名称" } },
        required: ["name"],
      },
    },
  },
];

async function agentLoop(messages: ChatCompletionMessageParam[]) {
  while (true) {
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
    messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls });
    if (!message.tool_calls?.length) {
      return messages;
    }

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
        } catch (e) {
          content = `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
        messages.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
    }
  }
}

if (import.meta.main) {
  console.log(`${SYSTEM}\n`);
  console.log("请输入内容后按回车...");
  for await (const chunk of Bun.stdin.stream()) {
    const chunkText = Buffer.from(chunk).toString();
    console.log(`[user]: ${chunkText}`);
    const messages: ChatCompletionMessageParam[] = [{ role: "user", content: chunkText }];
    const result = await agentLoop(messages);
    await Bun.write("result.json", JSON.stringify(result, null, 2));
    console.log(result.at(-1)?.content, "\n");
    console.log("完成");
  }
}

// 1. 有哪些技能可用？
// 2. 加载 agent-builder 技能并按照说明操作。
// 3. 我需要进行代码审查——请先加载相关技能。
// 4. 使用 mcp-builder 技能构建 MCP 服务器。
