import { writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../proc.ts";
import { AgentError, extractJson, type StepContext } from "./types.ts";

const AGENT = "Claude (builder)";

export interface BuildResult {
  summary: string;
  sessionId: string;
  costUsd: number | null;
}

export function writeBuilderMcpConfig(ctx: StepContext): string {
  const file = path.join(ctx.runDir, "builder-mcp.json");
  const config = {
    mcpServers: {
      Roblox_Studio: { command: ctx.config.studio.mcpCommand, args: ctx.config.studio.mcpArgs },
    },
  };
  writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  return file;
}

export async function runBuilder(
  ctx: StepContext,
  prompt: string,
  systemPromptFile: string,
  session: { id: string; resume: boolean },
): Promise<BuildResult> {
  const { config, roundDir, runDir, mirrorDir } = ctx;
  const logFile = path.join(roundDir, "build.log");
  writeFileSync(path.join(roundDir, "build-prompt.md"), prompt, "utf8");

  const args = [
    "-p",
    "--output-format",
    "json",
    "--mcp-config",
    path.join(runDir, "builder-mcp.json"),
    "--strict-mcp-config",
    "--append-system-prompt-file",
    systemPromptFile,
    "--allowedTools",
    "mcp__Roblox_Studio",
    "Read",
    "Grep",
    "Glob",
    "--disallowedTools",
    "Edit",
    "Write",
    "NotebookEdit",
    "Bash",
    "PowerShell",
    "--add-dir",
    runDir,
    ...[...new Set(config.guides.map((g) => path.dirname(g)))].flatMap((dir) => ["--add-dir", dir]),
    ...(session.resume ? ["--resume", session.id] : ["--session-id", session.id]),
  ];
  if (config.agents.builder.model) args.push("--model", config.agents.builder.model);

  const result = await runProcess({
    command: config.agents.builder.command,
    args,
    cwd: mirrorDir,
    stdin: prompt,
    logFile,
    timeoutMs: config.limits.agentTimeoutMinutes * 60_000,
    signal: ctx.signal,
    onLine: ctx.onLine,
  });

  if (result.aborted) throw new AgentError(AGENT, "stopped", logFile);
  if (result.timedOut) throw new AgentError(AGENT, "timed out", logFile);

  let parsed: { result?: string; session_id?: string; is_error?: boolean; total_cost_usd?: number };
  try {
    parsed = extractJson(result.stdout, "session_id");
  } catch {
    throw new AgentError(AGENT, `exited with code ${result.code} and no result`, logFile);
  }
  if (parsed.is_error || result.code !== 0) {
    throw new AgentError(AGENT, `reported an error: ${(parsed.result ?? "").slice(0, 500)}`, logFile);
  }

  const summary = parsed.result ?? "";
  writeFileSync(path.join(roundDir, "build-report.md"), summary, "utf8");
  return { summary, sessionId: parsed.session_id ?? session.id, costUsd: parsed.total_cost_usd ?? null };
}
