import { writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../proc.ts";
import type { BuilderSetup } from "../workspace/types.ts";
import { AgentError, extractJson, failure, type StepContext } from "./types.ts";

const AGENT = "Claude (builder)";

export interface BuildResult {
  summary: string;
  sessionId: string;
  costUsd: number | null;
}

interface ResultLine {
  type: "result";
  result?: string;
  session_id?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function finalResult(stdout: string): ResultLine | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseLine(lines[i]);
    if (parsed?.type === "result") return parsed as unknown as ResultLine;
  }
  try {
    const single = extractJson<ResultLine>(stdout, "session_id");
    return single;
  } catch {
    return null;
  }
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const target =
    input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? "";
  const short = String(target).replace(/\s+/g, " ").slice(0, 160);
  const label = name.startsWith("mcp__") ? name.split("__").slice(1).join(": ") : name;
  return short ? `${label}  ${short}` : label;
}

export function describeStreamLine(line: string): string | null {
  const parsed = parseLine(line);
  if (!parsed) return line.trim() ? line : null;
  if (parsed.type === "assistant") {
    const content = ((parsed.message as { content?: unknown[] })?.content ?? []) as Array<Record<string, unknown>>;
    const parts: string[] = [];
    for (const item of content) {
      if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
        parts.push(item.text.trim().replace(/\s+/g, " ").slice(0, 300));
      } else if (item.type === "tool_use") {
        parts.push(`▸ ${describeTool(String(item.name), (item.input ?? {}) as Record<string, unknown>)}`);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (parsed.type === "result") return parsed.is_error ? `✖ ${String(parsed.result ?? "error")}` : "✔ finished";
  return null;
}

export function writeBuilderMcpConfig(runDir: string, setup: BuilderSetup): string {
  const file = path.join(runDir, "builder-mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers: setup.mcpServers }, null, 2), "utf8");
  return file;
}

export async function runBuilder(
  ctx: StepContext,
  setup: BuilderSetup,
  prompt: string,
  systemPromptFile: string,
  session: { id: string; resume: boolean },
): Promise<BuildResult> {
  const { config, roundDir, runDir, workDir } = ctx;
  const logFile = path.join(roundDir, "build.log");
  writeFileSync(path.join(roundDir, "build-prompt.md"), prompt, "utf8");

  const dirs = [...new Set([runDir, ...setup.addDirs, ...ctx.guides.map((g) => path.dirname(g))])];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--mcp-config",
    path.join(runDir, "builder-mcp.json"),
    "--strict-mcp-config",
    "--append-system-prompt-file",
    systemPromptFile,
    "--allowedTools",
    ...setup.allowedTools,
    ...(setup.disallowedTools.length > 0 ? ["--disallowedTools", ...setup.disallowedTools] : []),
    ...dirs.flatMap((dir) => ["--add-dir", dir]),
    ...(session.resume ? ["--resume", session.id] : ["--session-id", session.id]),
  ];
  if (config.agents.builder.model) args.push("--model", config.agents.builder.model);
  if (config.agents.builder.effort) args.push("--effort", config.agents.builder.effort);

  const result = await runProcess({
    command: config.agents.builder.command,
    args,
    cwd: workDir,
    stdin: prompt,
    logFile,
    timeoutMs: config.limits.agentTimeoutMinutes * 60_000,
    signal: ctx.signal,
    onLine: ctx.onLine
      ? (line) => {
          const text = describeStreamLine(line);
          if (text) ctx.onLine!(text);
        }
      : undefined,
  });

  if (result.aborted) throw new AgentError(AGENT, "stopped", logFile);
  if (result.timedOut) throw new AgentError(AGENT, "timed out", logFile);

  const output = `${result.stdout}\n${result.stderr}`;
  if (/no conversation found/i.test(output)) {
    throw new AgentError(AGENT, "its earlier session could not be resumed", logFile, { noSession: true });
  }

  const parsed = finalResult(result.stdout);
  if (!parsed) throw failure(AGENT, `exited with code ${result.code} and no result`, logFile, output);
  if (parsed.is_error || result.code !== 0) {
    throw failure(AGENT, `reported an error: ${(parsed.result ?? "").slice(0, 500)}`, logFile, parsed.result || output);
  }

  const summary = parsed.result ?? "";
  writeFileSync(path.join(roundDir, "build-report.md"), summary, "utf8");
  return { summary, sessionId: parsed.session_id ?? session.id, costUsd: parsed.total_cost_usd ?? null };
}
