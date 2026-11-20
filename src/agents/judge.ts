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

export async function planBuild(ctx: StepContext, prompt: string): Promise<string> {
  const answer = await ask<{ instructions: string }>(ctx, prompt, "judge-build", "judge.schema.json", (a) => {
    if (typeof a.instructions !== "string" || !a.instructions.trim()) throw new Error("empty instructions");
  });
  writeFileSync(path.join(ctx.roundDir, "judge-build.md"), answer.instructions, "utf8");
  return answer.instructions;
}

export interface StartChoice {
  mode: "build" | "review";
  reason: string;
}

export function chooseStart(ctx: StepContext, prompt: string): Promise<StartChoice> {
  return askStructured<StartChoice>(ctx, prompt, {
    role: "judge", label: "judge-start", schema: "start.schema.json", key: "mode", taskOnly: true,
    validate(answer) {
      if (answer.mode !== "build" && answer.mode !== "review") throw new Error("expected a build or review starting step");
      if (typeof answer.reason !== "string") throw new Error("expected a reason for the starting step");
    },
  });
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
