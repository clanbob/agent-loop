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
    "json",
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

  const result = await runProcess({
    command: config.agents.builder.command,
    args,
    cwd: workDir,
    stdin: prompt,
    logFile,
    timeoutMs: config.limits.agentTimeoutMinutes * 60_000,
    signal: ctx.signal,
    onLine: ctx.onLine,
  });

  if (result.aborted) throw new AgentError(AGENT, "stopped", logFile);
  if (result.timedOut) throw new AgentError(AGENT, "timed out", logFile);

  const output = `${result.stdout}\n${result.stderr}`;
  if (/no conversation found/i.test(output)) {
    throw new AgentError(AGENT, "its earlier session could not be resumed", logFile, { noSession: true });
  }

  let parsed: { result?: string; session_id?: string; is_error?: boolean; total_cost_usd?: number };
  try {
    parsed = extractJson(result.stdout, "session_id");
  } catch {
    throw failure(AGENT, `exited with code ${result.code} and no result`, logFile, output);
  }
  if (parsed.is_error || result.code !== 0) {
    throw failure(AGENT, `reported an error: ${(parsed.result ?? "").slice(0, 500)}`, logFile, parsed.result || output);
  }

  const summary = parsed.result ?? "";
  writeFileSync(path.join(roundDir, "build-report.md"), summary, "utf8");
  return { summary, sessionId: parsed.session_id ?? session.id, costUsd: parsed.total_cost_usd ?? null };
}
