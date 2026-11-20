import { writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../proc.ts";
import { judgeModelId } from "../models.ts";
import { AgentError, extractJson, failure, type Finding, type StepContext } from "./types.ts";

const AGENT = "Antigravity (judge)";

const INLINE_PROMPT_CHARS = 24_000;

const BLOCKED_NOTE =
  "\n\nNote: your last attempt used a tool that is blocked here, which ended your turn with no answer. Do not run any shell commands this time, and only read files inside the project folder.";

export interface Decision {
  id: string;
  verdict: "fix" | "skip";
  reason: string;
}

export interface Triage {
  decisions: Decision[];
  instructions: string;
}

export async function runJudge(ctx: StepContext, prompt: string, label: string): Promise<string> {
  const answer = await ask<{ instructions: string }>(ctx, prompt, label, "judge.schema.json", (a) => {
    if (typeof a.instructions !== "string" || !a.instructions.trim()) throw new Error("empty instructions");
  });
  writeFileSync(path.join(ctx.roundDir, `${label}.md`), answer.instructions, "utf8");
  return answer.instructions;
}

export interface StartPlan {
  mode: "build" | "review";
  reason: string;
  instructions: string;
}

export async function runJudgeStart(ctx: StepContext, prompt: string): Promise<StartPlan> {
  const answer = await ask<StartPlan>(ctx, prompt, "judge-start", "start.schema.json", (a) => {
    if (typeof a.instructions !== "string" || !a.instructions.trim()) throw new Error("empty instructions");
  });
  const plan: StartPlan = {
    mode: answer.mode === "review" ? "review" : "build",
    reason: typeof answer.reason === "string" ? answer.reason.trim() : "",
    instructions: answer.instructions,
  };
  writeFileSync(path.join(ctx.roundDir, "judge-start.md"), plan.instructions, "utf8");
  writeFileSync(path.join(ctx.roundDir, "judge-start.json"), JSON.stringify(plan, null, 2), "utf8");
  return plan;
}

export async function runTriage(ctx: StepContext, prompt: string, findings: Finding[]): Promise<Triage> {
  const answer = await ask<Triage>(ctx, prompt, "judge-triage", "triage.schema.json", (a) => {
    if (!Array.isArray(a.decisions)) throw new Error("no decisions list");
  });

  const byId = new Map(answer.decisions.map((d) => [d.id, d]));
  const decisions: Decision[] = findings.map(
    (f) =>
      byId.get(f.id) ?? { id: f.id, verdict: "fix", reason: "The judge gave no verdict, so it is fixed to be safe." },
  );
  const toFix = findings.filter((f) => decisions.find((d) => d.id === f.id)?.verdict === "fix");
  let instructions = (answer.instructions ?? "").trim();
  if (toFix.length > 0 && !instructions) {
    instructions = `Fix these findings:\n${JSON.stringify(toFix, null, 2)}`;
  }
  if (toFix.length === 0) instructions = "";

  const triage = { decisions, instructions };
  writeFileSync(path.join(ctx.roundDir, "judge-triage.json"), JSON.stringify(triage, null, 2), "utf8");
  if (instructions) writeFileSync(path.join(ctx.roundDir, "judge-triage.md"), instructions, "utf8");
  return triage;
}

async function ask<T>(
  ctx: StepContext,
  prompt: string,
  label: string,
  schemaName: string,
  validate: (answer: T) => void,
): Promise<T> {
  const promptFile = path.join(ctx.roundDir, `${label}-prompt.md`);
  const logFile = path.join(ctx.roundDir, `${label}.log`);
  writeFileSync(promptFile, prompt, "utf8");

  const schemaFile = path.join(ctx.config.root, "schemas", schemaName);
  const basePrompt =
    prompt.length <= INLINE_PROMPT_CHARS
      ? prompt
      : `Read the file ${promptFile} and do exactly what it says. Reply only with the JSON it asks for.`;

  for (let attempt = 1; ; attempt++) {
    const text = attempt === 1 ? basePrompt : `${basePrompt}${BLOCKED_NOTE}`;
    const outcome = await runOnce<T>(ctx, text, schemaFile, logFile, validate);
    if ("answer" in outcome) return outcome.answer;
    if (attempt >= 2 || !outcome.commandDenied) throw outcome.error;
  }
}

async function runOnce<T>(
  ctx: StepContext,
  text: string,
  schemaFile: string,
  logFile: string,
  validate: (answer: T) => void,
): Promise<{ answer: T } | { error: AgentError; commandDenied: boolean }> {
  const { config, runDir, workDir } = ctx;
  const args = [
    "--print",
    text,
    "--output-format",
    "json",
    "--json-schema",
    schemaFile,
    "--mode",
    "plan",
    "--add-dir",
    runDir,
    "--add-dir",
    workDir,
    ...[...new Set(ctx.guides.map((g) => path.dirname(g)))].flatMap((dir) => ["--add-dir", dir]),
  ];
  if (config.agents.judge.model) args.push("--model", judgeModelId(config.agents.judge.model, config.agents.judge.effort));

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
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) throw failure(AGENT, `exited with code ${result.code}`, logFile, output);

  try {
    const answer = extractJson<T>(result.stdout, "instructions");
    validate(answer);
    return { answer };
  } catch (err) {
    const error = failure(AGENT, `could not read its answer: ${(err as Error).message}`, logFile, output);
    if (error.limit) throw error;
    return { error, commandDenied: /"denied_actions"\s*:\s*\[\s*\{/.test(output) };
  }
}
