import { writeFileSync } from "node:fs";
import path from "node:path";
import { askStructured } from "./structured.ts";
import type { Finding, StepContext } from "./types.ts";

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
  return askStructured<T>(ctx, prompt, { role: "judge", label, schema: schemaName, key: "instructions", validate });
}
