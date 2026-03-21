# AGENTS.md - 代理编码指南

## 语言要求

本项目为中国用户使用，**所有代码注释、文档、提交信息、代码审查回复以及与用户的沟通交流必须使用简体中文**。在回答问题、思考分析、编写代码注释等任何场景下，都必须使用中文。

---

本文件为在此仓库中运行的代理提供编码指南。

## 项目概述

- **运行时**：Bun（一体化 JavaScript 运行时）
- **语言**：TypeScript（ESNext，严格模式）
- **模块系统**：ES 模块（ESM）
- **代码格式化**：Biome
- **代码检查**：ultracite
- **AI SDK**：@ai-sdk/openai

## 命令

### 安装依赖
```bash
bun install
```

### 运行项目
```bash
bun run index.ts
```

### 类型检查
```bash
bun tsc --noEmit
```

### 代码检查与修复
```bash
npm run check      # 检查代码问题
npm run fix       # 自动修复代码问题
```

### 运行 Biome（代码格式化）
```bash
bunx biome check .           # 检查代码格式
bunx biome format --write . # 格式化代码
```

### 运行测试
本项目目前未配置测试框架。如需添加测试：
```bash
bun test                    # 运行所有测试
bun test <文件>             # 运行指定测试文件
bun test --watch            # 监听模式
```

## 代码风格指南

### TypeScript 配置
本项目使用严格模式的 TypeScript，关键配置如下：
- `strict: true` - 启用完整类型检查
- `verbatimModuleSyntax: true` - 不允许类型导入，必须使用 `import type`
- `noUncheckedIndexedAccess: true` - 数组访问返回包含 undefined 的联合类型
- `noImplicitOverride: true` - 继承方法必须使用 override 关键字
- `moduleResolution: bundler` - Bun 风格的模块解析

### 导入规则
- 使用显式导入并包含文件扩展名：`import { something } from "./file.ts"`
- 分组导入：外部库在前，内部模块在后
- 类型导入使用 `import type { Type } from "./file.ts"`
- 如 tsconfig 配置了路径别名，请使用别名

### 命名规范
- **文件**：kebab-case（例如 `agent-loop.ts`、`s01-agent-loop.ts`）
- **类/接口/类型**：PascalCase（例如 `AgentLoop`、`ToolResult`）
- **函数/变量**：camelCase（例如 `runAgent`、`toolResult`）
- **常量**：编译时常量用 UPPER_SNAKE_CASE，运行时常量用 camelCase
- **枚举**：枚举名和成员都用 PascalCase

### 类型规范
- 函数必须定义返回类型
- 复杂类型不要依赖类型推断，应显式声明
- 可能扩展的对象形状优先使用接口
- 联合类型、交叉类型和计算类型使用类型别名
- 使用 `import type` 进行类型导入

### 错误处理
- 使用 try/catch 并捕获特定错误类型
- 抛出错误时提供描述性信息和上下文
- 考虑为可能失败的操作使用 Result 类型

### 格式化（Biome）
Biome 配置继承自 ultracite/biome/core：
- 2 空格缩进
- 不使用分号（遵循 ESM 标准）
- 字符串使用单引号
- 多行对象/数组末尾加逗号
- 使用 `npm run fix` 自动格式化

### 最佳实践
- 新代码启用所有严格 TypeScript 检查
- 复杂逻辑使用注释说明
- 保持函数短小且专注
- 使用描述性的变量名
- 避免魔法数字，使用命名常量
- 提交前运行 `npm run check` 检查代码

## 目录结构

```
/
├── index.ts              # 入口文件
├── agents/               # 代理相关模块
│   └── *.ts             # 代理实现
├── tsconfig.json        # TypeScript 配置
├── biome.jsonc          # Biome 格式化配置
├── package.json         # 项目依赖
└── .env                 # 环境变量（不提交到版本控制）
```

## 环境变量

- 敏感值存储在 `.env` 文件中（已在 gitignore 中排除）
- 通过 `process.env.VARIABLE_NAME` 访问
- 切勿将密钥或凭证提交到版本控制

## 常用模式

本项目使用的核心代理循环模式：
```typescript
while (stopReason === "tool_use") {
  const response = await llm(messages, tools);
  const result = await executeTools(response);
  messages.push(result);
}
```

## AI SDK 使用

使用 @ai-sdk/openai 连接 AI 模型：
```typescript
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({
  name: "qwen",
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: config.dashScope.baseURL,
});
```

## 代理注意事项

- 使用 Bun 作为运行时和包管理器
- 使用 Biome + ultracite 进行代码检查和格式化
- 遵循 `agents/` 目录中现有的代码风格
- **使用中文进行所有交流**
- 提交前运行代码检查确保代码质量
