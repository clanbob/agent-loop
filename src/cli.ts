import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { loadConfig, type Config } from "./config.ts";
import { exportPlace } from "./studio/exporter.ts";
import { checkTools } from "./check.ts";
import { AgentLoop, listRuns, newRunId, skippedSoFar, type LimitPause, type PauseRequest, type RoundRecord } from "./loop.ts";
import { PROVIDERS, type AgentChoice, type AgentChoices, type Role } from "./roles.ts";
import { folderSpec, robloxSpec } from "./workspace/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): { command: string; flags: Map<string, string[]>; positional: string[] } {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags, positional };
}

async function check(config: Config): Promise<void> {
  for (const tool of await checkTools(config)) {
    const optional = tool.name === "Roblox Studio" && !tool.ok;
    const mark = tool.ok ? "OK  " : optional ? "--  " : "FAIL";
    console.log(`${mark}  ${tool.name}${optional ? " (only needed for --roblox runs)" : ""}: ${tool.detail}`);
  }
}

async function confirmInTerminal(pause: PauseRequest): Promise<boolean> {
  console.log(`\n=== PAUSED: ${pause.reason}`);
  for (const line of pause.details.slice(0, 30)) console.log(`  ${line}`);
  if (pause.details.length > 30) console.log(`  ...and ${pause.details.length - 30} more`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Continue the loop? [y/N] ").catch(() => "n");
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

async function waitForResumeInTerminal(pause: LimitPause, signal: AbortSignal): Promise<boolean> {
  console.log(`\n=== PAUSED: ${pause.agent} is out of usage (round ${pause.round})`);
  if (pause.message) console.log(`  ${pause.message}`);
  if (pause.resetAt) {
    const reset = new Date(pause.resetAt);
    console.log(`  Its limit resets around ${reset.toLocaleString()}.`);
  } else {
    console.log("  It did not say when its limit resets.");
  }
  console.log("  The run will not retry by itself. The step it was on will be retried when you resume.");
  console.log("  You can also close this window and later run: node src/cli.ts resume");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const cancelled = new Promise<string>((resolve) => {
    rl.once("SIGINT", () => resolve("stop"));
    signal.addEventListener("abort", () => resolve("stop"), { once: true });
  });
  try {
    for (;;) {
      const question = rl.question('Type "resume" to retry now, or "stop" to end the run: ').catch(() => "stop");
      const answer = (await Promise.race([question, cancelled])).trim().toLowerCase();
      if (answer === "resume" || answer === "r") return true;
      if (answer === "stop" || answer === "s") return false;
    }
  } finally {
    rl.close();
  }
}

const HOOKS = { confirmContinue: confirmInTerminal, waitForResume: waitForResumeInTerminal };

function agentChoices(config: Config, flags: Map<string, string[]>): AgentChoices {
  function pick(role: Role): AgentChoice {
    const selection = flags.get(role)?.[0];
    const [provider, ...model] = selection?.split(":") ?? [config.agents[role].provider];
    const agent = Object.values(config.agents).find((a) => a.provider === provider);
    if (!agent) throw new Error(`--${role} expects one of ${PROVIDERS.join(", ")}, optionally followed by :model-id`);
    const chosenModel = model.join(":") || agent.model;
    const effort = flags.get(`${role}-effort`)?.[0] ?? (chosenModel === agent.model ? agent.effort : null);
    return { provider: agent.provider, model: chosenModel, effort };
  }
  return { judge: pick("judge"), builder: pick("builder"), reviewer: pick("reviewer") };
}

async function manualReviewInTerminal(loop: AgentLoop, record: RoundRecord, signal: AbortSignal): Promise<void> {
  console.log(`\nReview round ${record.round}. Enter "fix N" or "skip N", then "send" to submit.\n`);
  for (const [index, f] of record.findings.entries()) {
    const choice = record.reviewDraft?.find((d) => d.id === f.id)?.verdict ?? "undecided";
    console.log(`${index + 1}. [${choice}] [${f.severity}] ${f.file}${f.line ? ":" + f.line : ""} — ${f.issue}`);
    if (f.suggestion) console.log(`   ${f.suggestion}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const close = () => rl.close();
  signal.addEventListener("abort", close, { once: true });
  rl.once("SIGINT", () => loop.stop());
  try {
    for await (const line of rl) {
      const command = line.trim().toLowerCase();
      if (command === "stop") break;
      if (command === "send") {
        try {
          loop.submitReview(record.round);
          return;
        } catch (err) {
          console.log((err as Error).message);
          continue;
        }
      }
      const match = /^(fix|skip)\s+(\d+)$/.exec(command);
      const finding = match && record.findings[Number(match[2]) - 1];
      if (!finding || !match) {
        console.log('Enter "fix N", "skip N", "send", or "stop".');
        continue;
      }
      loop.setReviewVerdict(record.round, finding.id, match[1] as "fix" | "skip");
      console.log(`${finding.id}: ${match[1]}`);
    }
    loop.stop();
  } finally {
    signal.removeEventListener("abort", close);
    rl.close();
  }
}

async function run(config: Config, flags: Map<string, string[]>): Promise<void> {
  const taskFile = flags.get("task-file")?.[0];
  const task = taskFile ? readFileSync(taskFile, "utf8") : flags.get("task")?.[0];
  if (!task) throw new Error('Give the task with --task "..." or --task-file path');

  const scope = flags.get("scope") ?? [];
  const guides = flags.get("guide") ?? [];
  const project = flags.get("project")?.[0];
  const roblox = flags.has("roblox");
  if (roblox === Boolean(project)) throw new Error("Give either --project <folder> or --roblox");

  const id = newRunId();
  const spec = project
    ? folderSpec(config, id, project, scope, guides, flags.get("test")?.[0] ?? null)
    : robloxSpec(config, scope, guides);
  await drive(AgentLoop.start(config, id, task, spec, HOOKS, agentChoices(config, flags), flags.has("manual-review")), flags);
}

async function resume(config: Config, runId: string | undefined, flags: Map<string, string[]>): Promise<void> {
  let id = runId;
  if (!id) {
    const candidates = listRuns(config).filter((r) => r.status !== "clean" && !r.alive);
    const latest = candidates[candidates.length - 1];
    if (!latest) throw new Error("There is no stopped, failed or interrupted run to resume.");
    id = latest.id;
  }
  await drive(AgentLoop.resume(config, id, HOOKS), flags);
}

function showRuns(config: Config): void {
  const runs = listRuns(config);
  if (runs.length === 0) return console.log("No saved runs.");
  for (const r of runs) {
    const status = r.alive ? "running" : r.status === "running" ? "interrupted" : r.status;
    const paused = r.pausedFor ? `, paused: ${r.pausedFor.agent} out of usage` : "";
    const firstLine = r.task.split(/\r?\n/)[0].slice(0, 60);
    console.log(`${r.id}  ${r.kind.padEnd(6)} ${status.padEnd(11)} round ${r.round}, ${r.step}${paused}  "${firstLine}"`);
  }
}

async function drive(loop: AgentLoop, flags: Map<string, string[]>): Promise<void> {
  const verbose = flags.has("verbose");

  loop.on("manualReview", (record, signal) => {
    manualReviewInTerminal(loop, record, signal).catch((err) => {
      console.error((err as Error).message);
      loop.stop();
    });
  });
  loop.on("phase", (phase, round) => console.log(`\n--- ${round ? `round ${round}: ` : ""}${phase}`));
  loop.on("log", (message) => console.log(message));
  loop.on("agentLine", (agent, line) => {
    if (verbose) console.log(`  [${agent}] ${line}`);
  });
  loop.on("round", (r) => {
    console.log(`Round ${r.round}: The reviewer reported ${r.findings.length} finding(s)`);
    for (const f of r.findings) console.log(`  ${f.id} [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} ${f.issue}`);
  });
  loop.on("triage", (_round, decisions) => {
    const fixes = decisions.filter((d) => d.verdict === "fix").length;
    console.log(`Decisions: ${fixes} to fix, ${decisions.length - fixes} skipped as not worth it`);
    for (const d of decisions) console.log(`  ${d.id} ${d.verdict.toUpperCase().padEnd(4)} ${d.reason}`);
  });

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\nStopping after killing the current agent... (Ctrl+C again to force quit)");
    loop.stop();
  });

  console.log(`Working on: ${loop.workspaceLabel}`);
  console.log(`Run folder: ${loop.runDir}`);
  const state = await loop.run();
  console.log(`\n=== ${state.status.toUpperCase()} after ${state.rounds.length} round(s)`);
  if (state.endReason === "no-findings") console.log("The reviewer reported no findings.");
  if (state.endReason === "rest-skipped") console.log("Every remaining finding was marked Skip.");
  if (state.error) console.log(`Reason: ${state.error}`);
  const skipped = skippedSoFar(state.rounds);
  if (skipped.length > 0) {
    console.log(`\nFindings marked Skip (${skipped.length}):`);
    for (const s of skipped) {
      console.log(`  round ${s.round} [${s.finding.severity}] ${s.finding.file}${s.finding.line ? `:${s.finding.line}` : ""} ${s.finding.issue}`);
      console.log(`      why skipped: ${s.reason}`);
    }
  }
  if (state.resultNote) console.log(state.resultNote);
  console.log(loop.runFolderDeleted ? "Run folder deleted." : `Details: ${loop.runDir}`);
  if (state.status !== "clean") console.log(`To continue this run later: node src/cli.ts resume ${state.id}`);
  process.exitCode = state.status === "clean" ? 0 : 1;
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));
  const config = loadConfig(ROOT, flags.get("config")?.[0]);

  if (command === "check") return check(config);
  if (command === "export") {
    const result = await exportPlace(config, "manual export");
    console.log(
      `Exported ${result.scriptCount} scripts to ${result.mirrorDir} (${result.changed ? "new commit" : "no changes"} ${result.commit.slice(0, 8)})`,
    );
    return;
  }
  if (command === "run") return run(config, flags);
  if (command === "resume") return resume(config, positional[0], flags);
  if (command === "runs") return showRuns(config);

  console.log(`Usage:
  node src/cli.ts run --project <folder> --task "..." [--test "npm test"] [--scope src/feature] [--guide file.md] [--verbose]
      Any git project. Works on a new branch in a separate worktree; your working copy is not touched.
      --scope limits where files may change (repeatable). --test runs after every build; failures become findings.
  node src/cli.ts run --roblox --task "..." --scope ServerScriptService/Feature [--scope ...] [--guide file.md] [--verbose]
      The open Roblox Studio place, edited live through the Studio MCP.
  Use --task-file task.md instead of --task for long tasks.
  Choose models independently with --judge provider:model --builder provider:model --reviewer provider:model.
  Providers are antigravity, claude and codex. Set effort with --judge-effort, --builder-effort or --reviewer-effort.
  Add --manual-review to mark each finding Fix or Skip and submit it before another build.

  node src/cli.ts runs                          list saved runs and where each one stopped
  node src/cli.ts resume [run-id] [--verbose]   continue a stopped or interrupted run (latest if no id)
  node src/cli.ts check                         check the three CLIs and the Roblox Studio connection
  node src/cli.ts export                        export every script in the Studio place to the mirror folder`);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
