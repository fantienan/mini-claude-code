// import * as Bun from "bun";

// for await (const chunk of Bun.stdin.stream()) {
//   // chunk is Uint8Array
//   // this converts it to text (assumes ASCII encoding)
//   const chunkText = Buffer.from(chunk).toString();
//   console.log(`Chunk: ${chunkText}`);
// }

const a = {
  function: {
    arguments:
      '{"items": \n[{"id": "1", "text": "读取 hello.py 文件内容", "status": "in_progress"}, {"id": "2", "text": "分析现有代码结构", "status": "pending"}, {"id": "3", "text": "添加类型提示", "status": "pending"}, {"id": "4", "text": "添加文档字符串", "status": "pending"}, {"id": "5", "text": "添加主程序入口保护", "status": "pending"}, {"id": "6", "text": "保存重构后的文件", "status": "pending"}]\n\n}',
    name: "todo",
  },
  id: "call_18c49e82f2b74f3da4a7399c",
  index: 0,
  type: "function",
};

const b = JSON.parse(a.function.arguments);
console.log(b);
