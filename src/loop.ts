import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { fillPrompt } from "./prompts.ts";
import { runJudge, runTriage, type Decision } from "./agents/judge.ts";
import { runBuilder, writeBuilderMcpConfig } from "./agents/builder.ts";
import { runReviewer } from "./agents/reviewer.ts";
import { AgentError, type Finding, type StepContext } from "./agents/types.ts";
import { createWorkspace, type Workspace, type WorkspaceSpec } from "./workspace/index.ts";
import { runTests } from "./tests.ts";
import { git } from "./git.ts";

export type Phase = "prepare" | "snapshot" | "test" | "judge" | "build" | "review" | "paused" | "done" | "stopped" | "failed";

export type Step = "prepare" | "judge-start" | "build" | "snapshot" | "review" | "repeat-check" | "judge-triage";

export interface RoundRecord {
  round: number;
  instructions: string;
  builderSummary: string;
  commit: string;
  changedFiles: string[];
  testExitCode: number | null;
  findings: Finding[];
  decisions: Decision[] | null;
  costUsd: number | null;
}

export interface SkippedFinding {
  round: number;
  finding: Finding;
  reason: string;
}

export interface TimelineEntry {
  phase: Phase;
  round: number;
  at: string;
}

export interface TimelineEntry {
  phase: Phase;
  round: number;
  at: string;
}

export interface LimitPause {
  agent: string;
  message: string;
  resetAt: string | null;
  round: number;
}

export type AgentChoice = { model: string | null; effort: string | null };

export interface AgentChoices {
  judge: AgentChoice;
  builder: AgentChoice;
  reviewer: AgentChoice;
}

export interface RunState {
  id: string;
  task: string;
  workspace: WorkspaceSpec;
  agents: AgentChoices | null;
  status: "running" | "clean" | "stopped" | "failed";
  cursor: { round: number; step: Step };
  baselineCommit: string;
  builderSessionId: string;
  instructions: string | null;
  roundsAllowed: number;
  buildStarted: boolean;
  currentBuild: { summary: string; costUsd: number | null } | null;
  currentSnapshot: {
    commit: string;
    changedFiles: string[];
    diffFile: string;
    test: { command: string; exitCode: number | null; timedOut: boolean; outputFile: string } | null;
  } | null;
  rounds: RoundRecord[];
  error: string | null;
  endReason: "no-findings" | "rest-skipped" | null;
  resultNote: string | null;
  pausedFor: LimitPause | null;
  timeline: TimelineEntry[];
  pid: number | null;
  startedAt: string;
  resumedAt: string[];
  finishedAt: string | null;
}

export interface PauseRequest {
  reason: string;
  details: string[];
}

export interface LoopHooks {
  confirmContinue: (pause: PauseRequest) => Promise<boolean>;
  waitForResume: (pause: LimitPause, signal: AbortSignal) => Promise<boolean>;
}

export interface LoopEvents {
  phase: [phase: Phase, round: number];
  log: [message: string];
  agentLine: [agent: string, line: string];
  round: [record: RoundRecord];
  triage: [round: number, decisions: Decision[]];
  finished: [state: RunState];
}

export interface RunSummary {
  id: string;
  kind: WorkspaceSpec["kind"];
  status: RunState["status"];
  task: string;
  round: number;
  step: Step;
  pausedFor: LimitPause | null;
  alive: boolean;
}

class RunStopped extends Error {}

const RESUME_NOTE =
  "You were cut off before you finished. Some of the work below may already be done. Re-read the affected files first, then finish whatever is left.";

const TEST_OUTPUT_LINES = 200;
const MAX_LISTED_FILES = 400;

function formatFindings(findings: Finding[]): string {
  return JSON.stringify(findings, null, 2);
}

function toFix(record: RoundRecord | null): Finding[] {
  if (!record) return [];
  if (!record.decisions) return record.findings;
  const fix = new Set(record.decisions.filter((d) => d.verdict === "fix").map((d) => d.id));
  return record.findings.filter((f) => fix.has(f.id));
}

export function skippedSoFar(rounds: RoundRecord[]): SkippedFinding[] {
  const out: SkippedFinding[] = [];
  for (const record of rounds) {
    for (const decision of record.decisions ?? []) {
      if (decision.verdict !== "skip") continue;
      const finding = record.findings.find((f) => f.id === decision.id);
      if (finding) out.push({ round: record.round, finding, reason: decision.reason });
    }
  }
  return out;
}

function guidesBlock(guides: string[]): string {
  const projectRules = "If the project has a CLAUDE.md or AGENTS.md file, its rules apply too.";
  if (guides.length === 0) return projectRules;
  return `The project's guides (read them; the code must follow them):\n${guides.map((g) => `- ${g}`).join("\n")}\n${projectRules}`;
}

function fileListing(dir: string): string {
  let files: string[];
  try {
    files = git(dir, ["ls-files"]).split(/\r?\n/).filter((f) => f && f !== "_manifest.json");
  } catch {
    return "(could not list files)";
  }
  if (files.length === 0) return "(no files yet)";
  const shown = files.slice(0, MAX_LISTED_FILES).join("\n");
  return files.length > MAX_LISTED_FILES ? `${shown}\n...and ${files.length - MAX_LISTED_FILES} more` : shown;
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

function isAlive(pid: number | null): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runsDir(config: Config): string {
  return path.join(config.dataDir, "runs");
}

function readState(runDir: string): RunState {
  return JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8")) as RunState;
}

function withAgentChoices(config: Config, choices: AgentChoices | null | undefined): Config {
  if (!choices) return config;
  const pick = (base: Config["agents"]["judge"], choice: AgentChoice | undefined) => ({
    ...base,
    model: choice?.model || base.model,
    effort: choice?.effort || base.effort,
  });
  return {
    ...config,
    agents: {
      judge: pick(config.agents.judge, choices.judge),
      builder: pick(config.agents.builder, choices.builder),
      reviewer: pick(config.agents.reviewer, choices.reviewer),
    },
  };
}

export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function listRuns(config: Config): RunSummary[] {
  const dir = runsDir(config);
  if (!existsSync(dir)) return [];
  const out: RunSummary[] = [];
  for (const id of readdirSync(dir).sort()) {
    if (!existsSync(path.join(dir, id, "run.json"))) continue;
    try {
      const s = readState(path.join(dir, id));
      out.push({
        id: s.id,
        kind: s.workspace?.kind ?? "roblox",
        status: s.status,
        task: s.task,
        round: s.cursor?.round ?? 0,
        step: s.cursor?.step ?? "prepare",
        pausedFor: s.pausedFor,
        alive: s.status === "running" && isAlive(s.pid),
      });
    } catch {}
  }
  return out;
}

export class AgentLoop extends EventEmitter<LoopEvents> {
  private config: Config;
  private hooks: LoopHooks;
  private abort = new AbortController();
  private resumeInterruptedBuild = false;
  private isNew: boolean;
  private workspace: Workspace;
  state: RunState;
  runDir: string;
  runFolderDeleted = false;

  private constructor(config: Config, hooks: LoopHooks, state: RunState, isNew: boolean) {
    super();
    this.config = config;
    this.hooks = hooks;
    this.state = state;
    this.runDir = path.join(runsDir(config), state.id);
    this.isNew = isNew;
    this.config = withAgentChoices(config, state.agents);
    this.workspace = createWorkspace(this.config, state.workspace);
  }

  static start(
    config: Config,
    id: string,
    task: string,
    workspace: WorkspaceSpec,
    hooks: LoopHooks,
    agents: AgentChoices | null = null,
  ): AgentLoop {
    const state: RunState = {
      id,
      task,
      workspace,
      agents,
      status: "running",
      cursor: { round: 0, step: "prepare" },
      baselineCommit: "",
      builderSessionId: randomUUID(),
      instructions: null,
      roundsAllowed: config.limits.roundsBeforePause,
      buildStarted: false,
      currentBuild: null,
      currentSnapshot: null,
      rounds: [],
      error: null,
      endReason: null,
      resultNote: null,
      pausedFor: null,
      timeline: [],
      pid: process.pid,
      startedAt: new Date().toISOString(),
      resumedAt: [],
      finishedAt: null,
    };
    return new AgentLoop(config, hooks, state, true);
  }

  static resume(config: Config, runId: string, hooks: LoopHooks): AgentLoop {
    const runDir = path.join(runsDir(config), runId);
    if (!existsSync(path.join(runDir, "run.json"))) throw new Error(`No saved run called ${runId}`);
    const state = readState(runDir);
    if (!state.workspace) throw new Error(`Run ${runId} was saved by an older version and cannot be resumed`);
    if (state.status === "clean") throw new Error(`Run ${runId} already finished clean`);
    if (state.status === "running" && isAlive(state.pid)) {
      throw new Error(`Run ${runId} is still running in another window (process ${state.pid})`);
    }

    const loop = new AgentLoop(config, hooks, state, false);
    if (state.cursor.step === "build" && state.buildStarted) loop.resumeInterruptedBuild = true;
    if (state.cursor.step === "review") state.cursor.step = "snapshot";
    state.status = "running";
    state.error = null;
    state.endReason = null;
    state.resultNote = null;
    state.finishedAt = null;
    state.pausedFor = null;
    state.pid = process.pid;
    state.resumedAt.push(new Date().toISOString());
    return loop;
  }

  get workspaceLabel(): string {
    return this.workspace.label;
  }

  stop(): void {
    this.abort.abort();
  }

  private phase(phase: Phase, round: number): void {
    (this.state.timeline ??= []).push({ phase, round, at: new Date().toISOString() });
    this.emit("phase", phase, round);
  }

  private save(): void {
    writeFileSync(path.join(this.runDir, "run.json"), JSON.stringify(this.state, null, 2), "utf8");
  }

  private context(roundDir: string, agent: string): StepContext {
    return {
      config: this.config,
      runDir: this.runDir,
      roundDir,
      workDir: this.workspace.workDir,
      guides: this.state.workspace.guides,
      signal: this.abort.signal,
      onLine: (line) => this.emit("agentLine", agent, line),
    };
  }

  private roundDir(round: number): string {
    const dir = path.join(this.runDir, `round-${String(round).padStart(2, "0")}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private checkStopped(): void {
    if (this.abort.signal.aborted) throw new RunStopped("stopped by user");
  }

  private async withLimitPause<T>(round: number, attempt: (retry: number) => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry++) {
      try {
        return await attempt(retry);
      } catch (err) {
        if (!(err instanceof AgentError) || !err.limit || this.abort.signal.aborted) throw err;
        const pause: LimitPause = {
          agent: err.agent,
          message: err.limit.message,
          resetAt: err.limit.resetAt?.toISOString() ?? null,
          round,
        };
        this.state.pausedFor = pause;
        this.save();
        this.phase("paused", round);
        const resume = await this.hooks.waitForResume(pause, this.abort.signal);
        this.state.pausedFor = null;
        this.save();
        if (!resume) throw new RunStopped(`stopped while ${err.agent} was out of usage`);
        this.checkStopped();
        this.emit("log", `Resuming: retrying ${err.agent}`);
      }
    }
  }

  async run(): Promise<RunState> {
    mkdirSync(this.runDir, { recursive: true });
    if (this.isNew) writeFileSync(path.join(this.runDir, "task.md"), this.state.task, "utf8");
    else this.emit("log", `Resuming run ${this.state.id} at round ${this.state.cursor.round}, step "${this.state.cursor.step}"`);
    this.save();

    try {
      await this.loop();
      this.state.status = "clean";
    } catch (err) {
      const stopped = this.abort.signal.aborted || err instanceof RunStopped;
      this.state.status = stopped ? "stopped" : "failed";
      this.state.error = (err as Error).message;
      this.phase(stopped ? "stopped" : "failed", this.state.cursor.round);
    }

    try {
      this.state.resultNote = await this.workspace.finish(this.state.status as "clean" | "stopped" | "failed");
    } catch (err) {
      this.emit("log", `Could not tidy up the workspace: ${(err as Error).message}`);
    }

    this.state.finishedAt = new Date().toISOString();
    this.state.pid = null;
    this.save();

    const policy = this.config.deleteRunFolder;
    if (policy === "always" || (policy === "onClean" && this.state.status === "clean")) {
      try {
        rmSync(this.runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        this.runFolderDeleted = true;
      } catch (err) {
        this.emit("log", `Could not delete run folder ${this.runDir}: ${(err as Error).message}`);
      }
    }

    this.emit("finished", this.state);
    return this.state;
  }

  private async loop(): Promise<void> {
    const { config, state, workspace } = this;
    const guides = guidesBlock(state.workspace.guides);

    const setupDir = this.roundDir(0);
    writeBuilderMcpConfig(this.runDir, workspace.builder);
    const systemPromptFile = path.join(this.runDir, "builder-system.md");
    writeFileSync(
      systemPromptFile,
      fillPrompt(config.root, "build-system", { workspace: workspace.notes.builder, guides }),
      "utf8",
    );

    const recordFor = (round: number) => state.rounds.find((r) => r.round === round) ?? null;

    for (;;) {
      this.checkStopped();
      const { round, step } = state.cursor;

      if (step === "prepare") {
        this.phase("prepare", 0);
        state.baselineCommit = await workspace.prepare();
        this.emit("log", `Working on ${workspace.label} (starting point ${state.baselineCommit.slice(0, 8)})`);
        state.cursor = { round: 0, step: "judge-start" };
      } else if (step === "judge-start") {
        this.phase("judge", 0);
        const prompt = fillPrompt(config.root, "judge-start", {
          task: state.task,
          workspace: workspace.notes.judge,
          files: fileListing(workspace.workDir),
          guides,
        });
        state.instructions = await this.withLimitPause(0, () =>
          runJudge(this.context(setupDir, "judge"), prompt, "judge-start"),
        );
        state.cursor = { round: 1, step: "build" };
      } else if (step === "build") {
        if (round > state.roundsAllowed) {
          const go = await this.hooks.confirmContinue({
            reason: `${round - 1} rounds done and Codex still reports findings.`,
            details: toFix(recordFor(round - 1)).map((f) => `[${f.severity}] ${f.file}: ${f.issue}`),
          });
          if (!go) throw new RunStopped(`paused after ${round - 1} rounds and not continued`);
          state.roundsAllowed += config.limits.roundsBeforePause;
          this.save();
        }

        this.phase("build", round);
        const instructions = state.instructions ?? "";
        const buildPrompt =
          round === 1
            ? fillPrompt(config.root, "build-first", { task: state.task, instructions })
            : fillPrompt(config.root, "build-fix", {
                round: String(round),
                instructions,
                findings: formatFindings(toFix(recordFor(round - 1))),
              });
        const buildContext = this.context(this.roundDir(round), "claude");
        const interrupted = this.resumeInterruptedBuild;

        state.buildStarted = true;
        this.save();
        const build = await this.withLimitPause(round, async (retry) => {
          const retrying = retry > 0 || interrupted;
          const prompt = retrying ? `${RESUME_NOTE}\n\n${buildPrompt}` : buildPrompt;
          const resume = round > 1 || retrying;
          try {
            return await runBuilder(buildContext, workspace.builder, prompt, systemPromptFile, {
              id: state.builderSessionId,
              resume,
            });
          } catch (err) {
            if (!(err instanceof AgentError) || !err.noSession) throw err;
            state.builderSessionId = randomUUID();
            this.emit("log", "Claude's earlier session was not found; starting a fresh one");
            return runBuilder(buildContext, workspace.builder, prompt, systemPromptFile, {
              id: state.builderSessionId,
              resume: false,
            });
          }
        });
        this.resumeInterruptedBuild = false;
        state.builderSessionId = build.sessionId;
        state.buildStarted = false;
        state.currentBuild = { summary: build.summary, costUsd: build.costUsd };
        state.cursor = { round, step: "snapshot" };
      } else if (step === "snapshot") {
        this.phase("snapshot", round);
        const roundDir = this.roundDir(round);
        const commit = await workspace.snapshot(`agent-loop run ${state.id}: round ${round}`);
        const previousCommit = recordFor(round - 1)?.commit ?? state.baselineCommit;
        const cumulativeFiles = workspace.changedFiles(state.baselineCommit, commit);
        const roundFiles = workspace.changedFiles(previousCommit, commit);
        const diffFile = path.join(roundDir, "diff.patch");
        writeFileSync(diffFile, workspace.diff(state.baselineCommit, commit), "utf8");
        writeFileSync(path.join(roundDir, "round-diff.patch"), workspace.diff(previousCommit, commit), "utf8");
        this.emit(
          "log",
          `Round ${round}: ${roundFiles.length} file(s) changed this round, ${cumulativeFiles.length} in total`,
        );

        if (cumulativeFiles.length === 0) {
          const go = await this.hooks.confirmContinue({
            reason: "Claude finished but nothing has changed.",
            details: [(state.currentBuild?.summary ?? "").slice(0, 1500)],
          });
          if (!go) throw new RunStopped("builder made no changes");
        }

        const strays = workspace.outOfScope(roundFiles);
        if (strays.length > 0) {
          const go = await this.hooks.confirmContinue({
            reason: "Claude changed files outside the allowed scope.",
            details: strays,
          });
          if (!go) throw new RunStopped("changes outside scope");
        }

        let test: NonNullable<RunState["currentSnapshot"]>["test"] = null;
        if (state.workspace.testCommand) {
          this.phase("test", round);
          test = await runTests(
            state.workspace.testCommand,
            workspace.workDir,
            path.join(roundDir, "tests.txt"),
            config.folder.testTimeoutMinutes * 60_000,
            this.abort.signal,
          );
          this.checkStopped();
          this.emit("log", `Tests ${test.exitCode === 0 ? "passed" : `failed (exit code ${test.exitCode}${test.timedOut ? ", timed out" : ""})`}`);
        }

        state.currentSnapshot = { commit, changedFiles: roundFiles, diffFile, test };
        state.cursor = { round, step: "review" };
      } else if (step === "review") {
        this.phase("review", round);
        const snap = state.currentSnapshot!;
        const previousFixes = toFix(recordFor(round - 1));
        const previousBlock =
          previousFixes.length > 0
            ? `Findings you reported in the previous round, which the builder was asked to fix (check that each is really fixed):\n${formatFindings(previousFixes)}`
            : "";
        const dismissed = skippedSoFar(state.rounds);
        const dismissedBlock =
          dismissed.length > 0
            ? `Findings from earlier rounds that the coordinator ruled not worth fixing. Do not report these again, unless a later change made one of them a serious problem:\n${dismissed.map((s) => `- ${s.finding.file}: ${s.finding.issue}`).join("\n")}`
            : "";
        let testsBlock = "";
        if (snap.test) {
          const lines = readFileSync(snap.test.outputFile, "utf8").split(/\r?\n/);
          const tail = lines.slice(-TEST_OUTPUT_LINES).join("\n");
          const result = snap.test.timedOut
            ? "timed out"
            : snap.test.exitCode === 0
              ? "passed (exit code 0)"
              : `FAILED (exit code ${snap.test.exitCode})`;
          testsBlock = `The project's tests were run with \`${snap.test.command}\` after this change and ${result}. Any failure caused by the change is a finding. Output${lines.length > TEST_OUTPUT_LINES ? ` (last ${TEST_OUTPUT_LINES} lines)` : ""}:\n\`\`\`\n${tail}\n\`\`\``;
        }
        const prompt = fillPrompt(config.root, "review", {
          task: state.task,
          workspace: workspace.notes.reviewer,
          guides,
          diff: readFileSync(snap.diffFile, "utf8"),
          tests: testsBlock,
          previous: previousBlock,
          dismissed: dismissedBlock,
        });
        const review = await this.withLimitPause(round, () =>
          runReviewer(this.context(this.roundDir(round), "codex"), prompt),
        );

        const record: RoundRecord = {
          round,
          instructions: state.instructions ?? "",
          builderSummary: state.currentBuild?.summary ?? "",
          commit: snap.commit,
          changedFiles: snap.changedFiles,
          testExitCode: snap.test?.exitCode ?? null,
          findings: review.findings,
          decisions: null,
          costUsd: state.currentBuild?.costUsd ?? null,
        };
        state.rounds = [...state.rounds.filter((r) => r.round !== round), record];
        this.emit("round", record);

        if (review.findings.length === 0) {
          state.endReason = "no-findings";
          this.save();
          this.phase("done", round);
          return;
        }
        state.cursor = { round, step: "judge-triage" };
      } else if (step === "judge-triage") {
        this.phase("judge", round);
        const record = recordFor(round)!;
        const earlierSkips = skippedSoFar(state.rounds.filter((r) => r.round < round));
        const prompt = fillPrompt(config.root, "judge-triage", {
          round: String(round),
          task: state.task,
          builderSummary: record.builderSummary,
          findings: formatFindings(record.findings),
          dismissed:
            earlierSkips.length > 0
              ? `Findings you ruled "skip" in earlier rounds (rule the same way on a finding that is just one of these again):\n${earlierSkips.map((s) => `- ${s.finding.file}: ${s.finding.issue} (your reason: ${s.reason})`).join("\n")}`
              : "",
          workspace: workspace.notes.judge,
          guides,
        });
        const triage = await this.withLimitPause(round, () =>
          runTriage(this.context(this.roundDir(round), "judge"), prompt, record.findings),
        );
        record.decisions = triage.decisions;
        this.emit("triage", round, triage.decisions);

        if (!triage.instructions) {
          state.endReason = "rest-skipped";
          this.save();
          this.phase("done", round);
          return;
        }
        state.instructions = triage.instructions;
        state.cursor = { round, step: "repeat-check" };
      } else if (step === "repeat-check") {
        const fixes = toFix(recordFor(round));
        const chains = repeatChains(state.rounds);
        const stuck = fixes.filter((f) => (chains.get(`${round}:${f.id}`) ?? 0) > config.limits.repeatedFindingPause);
        if (stuck.length > 0) {
          const go = await this.hooks.confirmContinue({
            reason: "These findings keep coming back after being fixed.",
            details: stuck.map((f) => `[${f.severity}] ${f.file}: ${f.issue}`),
          });
          if (!go) throw new RunStopped("stopped on repeating findings");
        }
        state.currentBuild = null;
        state.currentSnapshot = null;
        state.cursor = { round: round + 1, step: "build" };
      }

      this.save();
    }
  }
}
