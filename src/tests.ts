import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { killTree } from "./proc.ts";

export interface TestRun {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  outputFile: string;
}

export function runTests(
  command: string,
  cwd: string,
  outputFile: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<TestRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32" });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const onAbort = () => killTree(child.pid);
    signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      writeFileSync(outputFile, output, "utf8");
      resolve({ command, exitCode: code, timedOut, outputFile });
    });
  });
}
