import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../proc.ts";
import { AgentError, extractJson, type Review, type StepContext } from "./types.ts";

const AGENT = "Codex (reviewer)";

export async function runReviewer(ctx: StepContext, prompt: string): Promise<Review> {
  const { config, roundDir, mirrorDir } = ctx;
  const logFile = path.join(roundDir, "review.log");
  const outFile = path.join(roundDir, "review-raw.json");
  writeFileSync(path.join(roundDir, "review-prompt.md"), prompt, "utf8");

  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "--output-schema",
    path.join(config.root, "schemas", "review.schema.json"),
    "-o",
    outFile,
    "-C",
    mirrorDir,
  ];
  if (config.agents.reviewer.model) args.push("-m", config.agents.reviewer.model);
  args.push("-");

  const result = await runProcess({
    command: config.agents.reviewer.command,
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
  if (result.code !== 0) throw new AgentError(AGENT, `exited with code ${result.code}`, logFile);
  if (!existsSync(outFile)) throw new AgentError(AGENT, "wrote no final message", logFile);

  let review: Review;
  try {
    review = extractJson<Review>(readFileSync(outFile, "utf8"), "findings");
  } catch (err) {
    throw new AgentError(AGENT, `could not read its review: ${(err as Error).message}`, logFile);
  }
  if (!Array.isArray(review.findings)) throw new AgentError(AGENT, "findings is not a list", logFile);

  writeFileSync(path.join(roundDir, "review.json"), JSON.stringify(review, null, 2), "utf8");
  return review;
}
