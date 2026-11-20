import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../proc.ts";
import { AgentError, extractJson, failure, type Review, type StepContext } from "./types.ts";

const AGENT = "Codex (reviewer)";

export async function runReviewer(ctx: StepContext, prompt: string): Promise<Review> {
  const { config, roundDir, workDir } = ctx;
  const logFile = path.join(roundDir, "review.log");
  const outFile = path.join(roundDir, "review-raw.json");
  writeFileSync(path.join(roundDir, "review-prompt.md"), prompt, "utf8");

  rmSync(outFile, { force: true });
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
    workDir,
  ];
  if (config.agents.reviewer.model) args.push("-m", config.agents.reviewer.model);
  if (config.agents.reviewer.effort) args.push("-c", `model_reasoning_effort=${config.agents.reviewer.effort}`);
  args.push("-");

  const result = await runProcess({
    command: config.agents.reviewer.command,
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
  if (result.code !== 0) throw failure(AGENT, `exited with code ${result.code}`, logFile, output);
  if (!existsSync(outFile)) throw failure(AGENT, "wrote no final message", logFile, output);

  let review: Review;
  try {
    review = extractJson<Review>(readFileSync(outFile, "utf8"), "findings");
  } catch (err) {
    throw failure(AGENT, `could not read its review: ${(err as Error).message}`, logFile, output);
  }
  if (!Array.isArray(review.findings)) throw new AgentError(AGENT, "findings is not a list", logFile);

  writeFileSync(path.join(roundDir, "review.json"), JSON.stringify(review, null, 2), "utf8");
  return review;
}
