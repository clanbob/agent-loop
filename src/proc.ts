import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync } from "node:fs";
import path from "node:path";

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  logFile: string;
  hideArgs?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const resolved = new Map<string, string>();

export const IS_WINDOWS = process.platform === "win32";

function resolveOnPosix(command: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`Command not found on PATH: ${command}`);
}

export function resolveCommand(command: string): string {
  if (path.isAbsolute(command)) {
    if (!existsSync(command)) throw new Error(`Command not found: ${command}`);
    return command;
  }
  const cached = resolved.get(command);
  if (cached) return cached;

  if (!IS_WINDOWS) {
    const found = resolveOnPosix(command);
    resolved.set(command, found);
    return found;
  }

  let found: string[] = [];
  try {
    found = execFileSync("where.exe", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean);
  } catch {
    throw new Error(`Command not found on PATH: ${command}`);
  }
  const pick =
    found.find((f) => f.toLowerCase().endsWith(".exe")) ??
    found.find((f) => f.toLowerCase().endsWith(".cmd")) ??
    found.find((f) => f.toLowerCase().endsWith(".bat"));
  if (!pick) throw new Error(`No runnable .exe/.cmd found for ${command} (found: ${found.join(", ")})`);
  resolved.set(command, pick);
  return pick;
}

function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export function commandLine(exe: string, args: string[]) {
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(exe)) {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `"${[exe, ...args].map(quoteForCmd).join(" ")}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: exe, args, windowsVerbatimArguments: false };
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (IS_WINDOWS) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }, 3000).unref();
}

export function runProcess(opts: RunOptions): Promise<RunResult> {
  const exe = resolveCommand(opts.command);
  const invocation = commandLine(exe, opts.args);
  const child = spawn(invocation.file, invocation.args, {
    cwd: opts.cwd, windowsHide: true, detached: !IS_WINDOWS,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  const log = createWriteStream(opts.logFile, { flags: "a" });
  log.write(`$ ${exe} ${opts.hideArgs ? "(MCP configuration omitted)" : opts.args.join(" ")}\n(cwd ${opts.cwd})\n\n`);

  let stdout = "";
  let stderr = "";
  let pending = "";
  let pendingErr = "";
  let timedOut = false;
  let aborted = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const splitLines = (buffer: string, chunk: string): string => {
    const lines = (buffer + chunk).split(/\r?\n/);
    const rest = lines.pop() ?? "";
    for (const line of lines) opts.onLine?.(line);
    return rest;
  };

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    log.write(chunk);
    if (opts.onLine) pending = splitLines(pending, chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    log.write(chunk);
    if (opts.onLine) pendingErr = splitLines(pendingErr, chunk);
  });

  // A CLI can reject its flags and exit while a large prompt is still being written.
  let stdinError: Error | null = null;
  child.stdin.on("error", (err) => { stdinError = err; });
  if (opts.stdin !== undefined) child.stdin.end(opts.stdin, "utf8");
  else child.stdin.end();

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, opts.timeoutMs);

  const onAbort = () => {
    aborted = true;
    killTree(child.pid);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();

  return new Promise((resolve, reject) => {
    child.on("error", (err) => {
      clearTimeout(timer);
      log.end();
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (pending && opts.onLine) opts.onLine(pending);
      if (pendingErr && opts.onLine) opts.onLine(pendingErr);
      log.end(`\n[exit ${code}${timedOut ? ", timed out" : ""}${aborted ? ", stopped" : ""}]\n`);
      if (stdinError && code === 0 && !timedOut && !aborted) return reject(stdinError);
      resolve({ code, stdout, stderr, timedOut, aborted });
    });
  });
}
