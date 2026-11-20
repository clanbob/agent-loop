import { writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../proc.ts";
import { AgentError, extractJson, type StepContext } from "./types.ts";

const AGENT = "Antigravity (judge)";

export async function runJudge(ctx: StepContext, prompt: string, label: string): Promise<string> {
  const { config, roundDir, runDir, mirrorDir } = ctx;
  const promptFile = path.join(roundDir, `${label}-prompt.md`);
  const logFile = path.join(roundDir, `${label}.log`);
  writeFileSync(promptFile, prompt, "utf8");

  const schemaFile = path.join(config.root, "schemas", "judge.schema.json");
  const shortPrompt = `Read the file ${promptFile} and do exactly what it says. Reply only with the JSON it asks for.`;

  const args = [
    "--print",
    shortPrompt,
    "--output-format",
    "json",
    "--json-schema",
    schemaFile,
    "--mode",
    "plan",
    "--add-dir",
    runDir,
    "--add-dir",
    mirrorDir,
    ...[...new Set(config.guides.map((g) => path.dirname(g)))].flatMap((dir) => ["--add-dir", dir]),
  ];
  if (config.agents.judge.model) args.push("--model", config.agents.judge.model);

  const result = await runProcess({
    command: config.agents.judge.command,
    args,
    cwd: runDir,
    logFile,
    timeoutMs: config.limits.agentTimeoutMinutes * 60_000,
    signal: ctx.signal,
    onLine: ctx.onLine,
  });

  if (result.aborted) throw new AgentError(AGENT, "stopped", logFile);
  if (result.timedOut) throw new AgentError(AGENT, "timed out", logFile);
  if (result.code !== 0) throw new AgentError(AGENT, `exited with code ${result.code}`, logFile);

  try {
    const { instructions } = extractJson<{ instructions: string }>(result.stdout, "instructions");
    if (!instructions.trim()) throw new Error("empty instructions");
    writeFileSync(path.join(roundDir, `${label}.md`), instructions, "utf8");
    return instructions;
  } catch (err) {
    throw new AgentError(AGENT, `could not read its answer: ${(err as Error).message}`, logFile);
  }
}
