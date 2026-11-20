import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { exportPlace, safeName } from "./studio/exporter.ts";
import { diff, changedFiles } from "./git.ts";
import { fillPrompt, bulletList } from "./prompts.ts";
import { runJudge } from "./agents/judge.ts";
import { runBuilder, writeBuilderMcpConfig } from "./agents/builder.ts";
import { runReviewer } from "./agents/reviewer.ts";
import type { Finding, Review, StepContext } from "./agents/types.ts";

export type Phase = "export" | "judge" | "build" | "review" | "done" | "stopped" | "failed";

export interface RunRequest {
  task: string;
  scope: string[];
}

export interface RoundRecord {
  round: number;
  instructions: string;
  builderSummary: string;
  commit: string;
  changedFiles: string[];
  findings: Finding[];
  costUsd: number | null;
}

export interface RunState {
  id: string;
  task: string;
  scope: string[];
  status: "running" | "clean" | "stopped" | "failed";
  baselineCommit: string;
  builderSessionId: string;
  rounds: RoundRecord[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface PauseRequest {
  reason: string;
  details: string[];
}

export interface LoopHooks {
  confirmContinue: (pause: PauseRequest) => Promise<boolean>;
}

export interface LoopEvents {
  phase: [phase: Phase, round: number];
  log: [message: string];
  agentLine: [agent: string, line: string];
  round: [record: RoundRecord];
  finished: [state: RunState];
}

function scopePrefixes(scope: string[]): string[] {
  return scope.map((s) =>
    s
      .split(/[/.\\]/)
      .filter(Boolean)
      .map((seg) => safeName(seg, 1))
      .join("/")
      .toLowerCase(),
  );
}

function outOfScope(files: string[], scope: string[]): string[] {
  const prefixes = scopePrefixes(scope);
  return files.filter((file) => {
    const f = file.toLowerCase();
    return !prefixes.some((p) => f === p || f.startsWith(`${p}/`) || f.startsWith(`${p}.`));
  });
}

function formatFindings(findings: Finding[]): string {
  return JSON.stringify(findings, null, 2);
}

function repeatChains(rounds: RoundRecord[]): Map<string, number> {
  const depth = new Map<string, number>();
  for (const round of rounds) {
    for (const f of round.findings) {
      const key = `${round.round}:${f.id}`;
      const prev = f.repeat_of ? depth.get(`${round.round - 1}:${f.repeat_of}`) ?? 1 : 0;
      depth.set(key, prev + 1);
    }
  }
  return depth;
}

export class AgentLoop extends EventEmitter<LoopEvents> {
  private config: Config;
  private hooks: LoopHooks;
  private abort = new AbortController();
  state: RunState;
  runDir: string;

  constructor(config: Config, request: RunRequest, hooks: LoopHooks) {
    super();
    this.config = config;
    this.hooks = hooks;
    const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.runDir = path.join(config.root, "runs", id);
    this.state = {
      id,
      task: request.task,
      scope: request.scope,
      status: "running",
      baselineCommit: "",
      builderSessionId: randomUUID(),
      rounds: [],
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
  }

  stop(): void {
    this.abort.abort();
  }

  private save(): void {
    writeFileSync(path.join(this.runDir, "run.json"), JSON.stringify(this.state, null, 2), "utf8");
  }

  private context(roundDir: string, mirrorDir: string, agent: string): StepContext {
    return {
      config: this.config,
      runDir: this.runDir,
      roundDir,
      mirrorDir,
      signal: this.abort.signal,
      onLine: (line) => this.emit("agentLine", agent, line),
    };
  }

  private checkStopped(): void {
    if (this.abort.signal.aborted) throw new Error("stopped by user");
  }

  async run(): Promise<RunState> {
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(path.join(this.runDir, "task.md"), this.state.task, "utf8");
    this.save();

    try {
      await this.loop();
      this.state.status = "clean";
    } catch (err) {
      const stopped = this.abort.signal.aborted;
      this.state.status = stopped ? "stopped" : "failed";
      this.state.error = (err as Error).message;
      this.emit("phase", stopped ? "stopped" : "failed", this.state.rounds.length);
    }

    this.state.finishedAt = new Date().toISOString();
    this.save();
    this.emit("finished", this.state);
    return this.state;
  }

  private async loop(): Promise<void> {
    const { config, state } = this;
    const guides = bulletList(config.guides);
    const scope = bulletList(state.scope);

    this.emit("phase", "export", 0);
    const baseline = await exportPlace(config, `run ${state.id}: before task`);
    state.baselineCommit = baseline.commit;
    const mirrorDir = baseline.mirrorDir;
    this.emit("log", `Exported ${baseline.scriptCount} scripts (baseline ${baseline.commit.slice(0, 8)})`);
    this.save();

    const setupDir = path.join(this.runDir, "round-00");
    mkdirSync(setupDir, { recursive: true });
    writeBuilderMcpConfig(this.context(setupDir, mirrorDir, "setup"));
    const systemPromptFile = path.join(this.runDir, "builder-system.md");
    writeFileSync(systemPromptFile, fillPrompt(config.root, "build-system", { scope, mirrorDir }), "utf8");

    this.checkStopped();
    this.emit("phase", "judge", 0);
    let instructions = await runJudge(
      this.context(setupDir, mirrorDir, "judge"),
      fillPrompt(config.root, "judge-start", { task: state.task, scope, mirrorDir, guides }),
      "judge-start",
    );

    let roundsAllowed = config.limits.roundsBeforePause;
    let previous: Review | null = null;

    for (let round = 1; ; round++) {
      if (round > roundsAllowed) {
        const go = await this.hooks.confirmContinue({
          reason: `${round - 1} rounds done and Codex still reports findings.`,
          details: (previous?.findings ?? []).map((f) => `[${f.severity}] ${f.file}: ${f.issue}`),
        });
        if (!go) throw new Error(`paused after ${round - 1} rounds and not continued`);
        roundsAllowed += config.limits.roundsBeforePause;
      }

      const roundDir = path.join(this.runDir, `round-${String(round).padStart(2, "0")}`);
      mkdirSync(roundDir, { recursive: true });

      this.checkStopped();
      this.emit("phase", "build", round);
      const buildPrompt =
        round === 1
          ? fillPrompt(config.root, "build-first", { task: state.task, instructions })
          : fillPrompt(config.root, "build-fix", {
              round: String(round),
              instructions,
              findings: formatFindings(previous?.findings ?? []),
            });
      const build = await runBuilder(this.context(roundDir, mirrorDir, "claude"), buildPrompt, systemPromptFile, {
        id: state.builderSessionId,
        resume: round > 1,
      });
      state.builderSessionId = build.sessionId;

      this.checkStopped();
      this.emit("phase", "export", round);
      const exported = await exportPlace(config, `run ${state.id}: round ${round}`);
      const cumulativeFiles = changedFiles(mirrorDir, state.baselineCommit, exported.commit);
      const roundFiles = round === 1 ? cumulativeFiles : changedFiles(mirrorDir, state.rounds[round - 2].commit, exported.commit);
      const fullDiff = diff(mirrorDir, state.baselineCommit, exported.commit);
      writeFileSync(path.join(roundDir, "diff.patch"), fullDiff, "utf8");
      writeFileSync(path.join(roundDir, "round-diff.patch"), round === 1 ? fullDiff : diff(mirrorDir, state.rounds[round - 2].commit, exported.commit), "utf8");
      this.emit("log", `Round ${round}: ${roundFiles.length} script(s) changed this round, ${cumulativeFiles.length} in total`);

      if (cumulativeFiles.length === 0) {
        const go = await this.hooks.confirmContinue({
          reason: "Claude finished but no script in the place has changed.",
          details: [build.summary.slice(0, 1500)],
        });
        if (!go) throw new Error("builder made no changes");
      }

      const strays = outOfScope(roundFiles, state.scope);
      if (strays.length > 0) {
        const go = await this.hooks.confirmContinue({
          reason: "Claude changed scripts outside the allowed scope.",
          details: strays,
        });
        if (!go) throw new Error("changes outside scope");
      }

      this.checkStopped();
      this.emit("phase", "review", round);
      const previousBlock = previous
        ? `Findings you reported in the previous round, which the builder was asked to fix (check that each is really fixed):\n${formatFindings(previous.findings)}`
        : "";
      const review = await runReviewer(
        this.context(roundDir, mirrorDir, "codex"),
        fillPrompt(config.root, "review", {
          task: state.task,
          scope,
          guides,
          diff: fullDiff,
          previous: previousBlock,
        }),
      );

      const record: RoundRecord = {
        round,
        instructions,
        builderSummary: build.summary,
        commit: exported.commit,
        changedFiles: roundFiles,
        findings: review.findings,
        costUsd: build.costUsd,
      };
      state.rounds.push(record);
      this.save();
      this.emit("round", record);

      if (review.findings.length === 0) {
        this.emit("phase", "done", round);
        return;
      }

      const chains = repeatChains(state.rounds);
      const stuck = review.findings.filter(
        (f) => (chains.get(`${round}:${f.id}`) ?? 0) > config.limits.repeatedFindingPause,
      );
      if (stuck.length > 0) {
        const go = await this.hooks.confirmContinue({
          reason: "These findings keep coming back after being fixed.",
          details: stuck.map((f) => `[${f.severity}] ${f.file}: ${f.issue}`),
        });
        if (!go) throw new Error("stopped on repeating findings");
      }

      this.checkStopped();
      this.emit("phase", "judge", round);
      instructions = await runJudge(
        this.context(roundDir, mirrorDir, "judge"),
        fillPrompt(config.root, "judge-triage", {
          round: String(round),
          task: state.task,
          builderSummary: build.summary,
          findings: formatFindings(review.findings),
          mirrorDir,
          guides,
        }),
        "judge-triage",
      );
      previous = review;
    }
  }
}
