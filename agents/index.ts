import { spawn } from "node:child_process";

const WORKDIR = process.cwd();

console.log(WORKDIR);
async function runBash({ command }: { command: string }) {
  try {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
      throw new Error("命令包含危险操作");
    }

    const isWindows = process.platform === "win32";
    const proc = spawn(isWindows ? "cmd" : "sh", ["/c", command], {
      cwd: WORKDIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: isWindows,
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
const isWindows = process.platform === "win32";
console.log(await runBash({ command: isWindows ? "dir" : "ls" }));
