import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withAgentChoices, type Config } from "./config.ts";
import type { AgentChoices, Role } from "./roles.ts";
import { fillPrompt } from "./prompts.ts";
import { chooseStart, planBuild, runTriage, type Decision, type StartChoice, type Triage } from "./agents/judge.ts";
import { runBuilder, writeBuilderMcpConfig } from "./agents/builder.ts";
import { runReviewer } from "./agents/reviewer.ts";
import { AgentError, type Finding, type StepContext } from "./agents/types.ts";
import { createWorkspace, type Workspace, type WorkspaceSpec } from "./workspace/index.ts";
import { runTests } from "./tests.ts";
import { git } from "./git.ts";

export type { AgentChoice, AgentChoices } from "./roles.ts";

export type Phase = "prepare" | "choose-start" | "snapshot" | "test" | "judge" | "build" | "review" | "manual-review" | "paused" | "done" | "stopped" | "failed";

export type Step = "prepare" | "judge-start" | "plan-build" | "build" | "snapshot" | "review" | "repeat-check" | "judge-triage" | "manual-review";

export interface RoundRecord {
  round: number;
  instructions: string;
  builderSummary: string;
  commit: string;
  changedFiles: string[];
  testExitCode: number | null;
  findings: Finding[];
  decisions: Decision[] | null;
  reviewDraft?: Pick<Decision, "id" | "verdict">[];
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

export interface LimitPause {
  agent: string;
  message: string;
  resetAt: string | null;
  round: number;
}

export interface RunState {
  id: string;
  task: string;
  workspace: WorkspaceSpec;
  agents: AgentChoices | null;
  manualReview?: boolean;
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
  startMode?: "build" | "review" | null;
  startReason?: string | null;
  buildsDone?: number;
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
  manualReview: [record: RoundRecord, signal: AbortSignal];
  reviewChanged: [];
  reviewSubmitted: [];
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

// Fast paths for explicit prefixes and common opening actions. Leave ambiguous wording to the judge.
function requestedStart(task: string): StartChoice["mode"] | null {
  const opening = task.trimStart().replace(/^(?:(?:please|(?:can|could|would) you)\s+)+/i, "");
  if (/^review\s*:/i.test(opening)) return "review";
  if (/^build\s*:/i.test(opening)) return "build";
  const change = opening.search(/\b(?:add|build|change|create|fix|implement|refactor|remove|replace|update|write)\b/i);
  if (change === 0) return "build";
  if (change > 0) return null;

  const reviewAction = /^(?:review|audit|inspect|diagnose|scan|check (?:the|this|my|our|existing))\b/i;
  const reviewTask = /^(?:do|run|perform|conduct)\s+(?:(?:an?|the|complete|full|thorough|comprehensive|diagnostic|code|performance|security)\s+)*(?:review|audit|scan|inspection)\b/i;
  return reviewAction.test(opening) || reviewTask.test(opening) ? "review" : null;
}

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
    manualReview = false,
  ): AgentLoop {
    const selected = withAgentChoices(config, agents).agents;
    const choice = (role: Role) => {
      const { provider, model, effort } = selected[role];
      return { provider, model, effort };
    };
    const state: RunState = {
      id,
      task,
      workspace,
      agents: { judge: choice("judge"), builder: choice("builder"), reviewer: choice("reviewer") },
      manualReview,
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
      startMode: null,
      startReason: null,
      buildsDone: 0,
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
    if (state.startMode === "review" && state.cursor.round === 1 && state.cursor.step === "snapshot") {
      // Older versions saved a judge-authored review brief here.
      state.instructions = null;
    }
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

  get pendingReviewRound(): number | null {
    const { cursor, status, rounds } = this.state;
    if (status !== "running" || cursor.step !== "manual-review" || this.abort.signal.aborted) return null;
    const record = rounds.find((r) => r.round === cursor.round);
    return record?.decisions === null ? cursor.round : null;
  }

  private pendingReview(round: number): RoundRecord {
    if (typeof round !== "number" || this.pendingReviewRound !== round) throw new Error("This round is no longer waiting for review.");
    return this.state.rounds.find((r) => r.round === round)!;
  }

  private saveReview(record: RoundRecord, update: Partial<Pick<RoundRecord, "reviewDraft" | "decisions">>): void {
    const rounds = this.state.rounds.map((r) => r === record ? { ...r, ...update } : r);
    this.save({ ...this.state, rounds });
    Object.assign(record, update);
  }

  setReviewVerdict(round: number, id: string, verdict: Decision["verdict"]): void {
    const record = this.pendingReview(round);
    if (!record.findings.some((f) => f.id === id)) throw new Error("Unknown finding.");
    if (verdict !== "fix" && verdict !== "skip") throw new Error("Choose Fix or Skip.");
    const reviewDraft = [...(record.reviewDraft ?? []).filter((d) => d.id !== id), { id, verdict }];
    this.saveReview(record, { reviewDraft });
    this.emit("reviewChanged");
  }

  submitReview(round: number): void {
    const record = this.pendingReview(round);
    const draft = new Map(record.reviewDraft?.map((d) => [d.id, d.verdict]));
    const decisions = record.findings.map(({ id }) => {
      const verdict = draft.get(id);
      if (!verdict) throw new Error("Choose Fix or Skip for every finding before submitting.");
      return { id, verdict, reason: `You marked this finding ${verdict === "fix" ? "Fix" : "Skip"}.` };
    });
    this.saveReview(record, { decisions, reviewDraft: undefined });
    this.emit("reviewSubmitted");
  }

  private async manualTriage(record: RoundRecord): Promise<Triage> {
    // A restart after submission but before the next step reuses the saved decisions.
    if (!record.decisions) {
      const submitted = once(this, "reviewSubmitted", { signal: this.abort.signal });
      this.phase("manual-review", record.round);
      this.emit("manualReview", record, this.abort.signal);
      await submitted;
      this.checkStopped();
    }
    const fixes = toFix(record);
    return {
      decisions: record.decisions!,
      instructions: fixes.length ? `Fix the selected findings: ${fixes.map((f) => f.id).join(", ")}.` : "",
    };
  }

  private phase(phase: Phase, round: number): void {
    (this.state.timeline ??= []).push({ phase, round, at: new Date().toISOString() });
    this.emit("phase", phase, round);
  }

  private save(state = this.state): void {
    const file = path.join(this.runDir, "run.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), "utf8");
    renameSync(`${file}.tmp`, file);
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

  private async startingPoint(): Promise<StartChoice> {
    const { task } = this.state;
    const mode = requestedStart(task);
    if (mode) return { mode, reason: "" };

    this.phase("choose-start", 0);
    const dir = path.join(this.roundDir(0), "routing");
    mkdirSync(dir, { recursive: true });
    const ctx = { ...this.context(dir, "judge"), workDir: dir, guides: [] };
    const prompt = fillPrompt(this.config.root, "judge-start", { task });
    return this.withLimitPause(0, () => chooseStart(ctx, prompt));
  }

  private judgeTriage(record: RoundRecord): Promise<Triage> {
    const { round } = record;
    this.phase("judge", round);
    const earlierSkips = skippedSoFar(this.state.rounds.filter((r) => r.round < round));
    const prompt = fillPrompt(this.config.root, "judge-triage", {
      round: String(round),
      task: this.state.task,
      builderSummary: record.builderSummary,
      findings: formatFindings(record.findings),
      dismissed:
        earlierSkips.length > 0
          ? `Findings you ruled "skip" in earlier rounds (rule the same way on a finding that is just one of these again):\n${earlierSkips.map((s) => `- ${s.finding.file}: ${s.finding.issue} (your reason: ${s.reason})`).join("\n")}`
          : "",
      workspace: this.workspace.notes.judge,
    });
    const dir = path.join(this.roundDir(round), "triage");
    mkdirSync(dir, { recursive: true });
    const ctx = { ...this.context(this.roundDir(round), "judge"), workDir: dir, guides: [] };
    return this.withLimitPause(round, () => runTriage(ctx, prompt, record.findings));
  }

  private async loop(): Promise<void> {
    const { config, state, workspace } = this;
    const guides = guidesBlock(state.workspace.guides);

    if (config.agents.builder.provider === "claude") writeBuilderMcpConfig(this.runDir, workspace.builder);
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
      const initialReview = state.startMode === "review" && round === 1;

      if (step === "prepare") {
        this.phase("prepare", 0);
        state.baselineCommit = await workspace.prepare();
        this.emit("log", `Working on ${workspace.label} (starting point ${state.baselineCommit.slice(0, 8)})`);
        state.cursor = { round: 0, step: "judge-start" };
      } else if (step === "judge-start") {
        const start = await this.startingPoint();
        state.startMode = start.mode;
        state.startReason = start.reason || null;
        state.instructions = null;
        const first = start.mode === "review" ? "a review of the existing code" : "a build";
        this.emit("log", `Starting with ${first}${start.reason ? `: ${start.reason}` : ""}`);
        state.cursor = start.mode === "review" ? { round: 1, step: "snapshot" } : { round: 0, step: "plan-build" };
      } else if (step === "plan-build") {
        this.phase("judge", 0);
        const prompt = fillPrompt(config.root, "judge-build", {
          task: state.task,
          workspace: workspace.notes.judge,
          files: fileListing(workspace.workDir),
          guides,
        });
        state.instructions = await this.withLimitPause(0, () =>
          planBuild(this.context(this.roundDir(0), "judge"), prompt),
        );
        state.cursor = { round: 1, step: "build" };
      } else if (step === "build") {
        if (round > state.roundsAllowed) {
          const go = await this.hooks.confirmContinue({
            reason: `${round - 1} rounds done and the reviewer still reports findings.`,
            details: toFix(recordFor(round - 1)).map((f) => `[${f.severity}] ${f.file}: ${f.issue}`),
          });
          if (!go) throw new RunStopped(`paused after ${round - 1} rounds and not continued`);
          state.roundsAllowed += config.limits.roundsBeforePause;
          this.save();
        }

        this.phase("build", round);
        const instructions = state.instructions ?? "";
        const buildsDone = state.buildsDone ?? round - 1;
        const fixFindings = formatFindings(toFix(recordFor(round - 1)));
        const buildPrompt =
          buildsDone === 0 && round === 1
            ? fillPrompt(config.root, "build-first", { task: state.task, instructions })
            : buildsDone === 0
              ? fillPrompt(config.root, "build-fix-first", { task: state.task, instructions, findings: fixFindings })
              : fillPrompt(config.root, "build-fix", { round: String(round), instructions, findings: fixFindings });
        const buildContext = this.context(this.roundDir(round), "builder");
        const interrupted = this.resumeInterruptedBuild;

        state.buildStarted = true;
        this.save();
        const build = await this.withLimitPause(round, async (retry) => {
          const retrying = retry > 0 || interrupted;
          const taskContext = config.agents.builder.provider !== "claude" && buildsDone > 0
            ? `Original task:\n${state.task}\n\n` : "";
          const prompt = `${retrying ? RESUME_NOTE + "\n\n" : ""}${taskContext}${buildPrompt}`;
          const resume = buildsDone > 0 || retrying;
          try {
            return await runBuilder(buildContext, workspace.builder, prompt, systemPromptFile, {
              id: state.builderSessionId,
              resume,
            });
          } catch (err) {
            if (!(err instanceof AgentError) || !err.noSession) throw err;
            state.builderSessionId = randomUUID();
            this.emit("log", "The builder's earlier session was not found; starting a fresh one");
            return runBuilder(buildContext, workspace.builder, prompt, systemPromptFile, {
              id: state.builderSessionId,
              resume: false,
            });
          }
        });
        this.resumeInterruptedBuild = false;
        state.builderSessionId = build.sessionId;
        state.buildStarted = false;
        state.buildsDone = buildsDone + 1;
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

        if (workspace.tracksChanges && cumulativeFiles.length === 0 && !initialReview) {
          const go = await this.hooks.confirmContinue({
            reason: "The builder finished but nothing has changed.",
            details: [(state.currentBuild?.summary ?? "").slice(0, 1500)],
          });
          if (!go) throw new RunStopped("builder made no changes");
        }

        const strays = workspace.tracksChanges ? workspace.outOfScope(roundFiles) : [];
        if (strays.length > 0) {
          const go = await this.hooks.confirmContinue({
            reason: "The builder changed files outside the allowed scope.",
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
            ? `Findings marked Skip in earlier rounds. Do not report these again, unless a later change made one of them a serious problem:\n${dismissed.map((s) => `- ${s.finding.file}: ${s.finding.issue}`).join("\n")}`
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
          testsBlock = `The project's tests ran with \`${snap.test.command}\` and ${result}. Report failures relevant to the scope of this review. Output${lines.length > TEST_OUTPUT_LINES ? ` (last ${TEST_OUTPUT_LINES} lines)` : ""}:\n\`\`\`\n${tail}\n\`\`\``;
        }
        const prompt = fillPrompt(config.root, "review", {
          task: state.task,
          workspace: workspace.notes.reviewer,
          guides,
          scope: initialReview
            ? "Inspect the existing code identified in the user's request. Read its implementation and relevant dependencies directly, and report findings within the requested scope."
            : "Review the code changed or added for this task and how it fits with the rest. Check that the changes fulfill the request. Limit findings to problems in this work.",
          changes: initialReview
            ? ""
            : workspace.tracksChanges
              ? `All changes made so far in this task (a git diff against the code before the task started):\n\`\`\`diff\n${readFileSync(snap.diffFile, "utf8")}\n\`\`\``
              : `There is no diff for this run: the work was done live through MCP tools. What the builder reported doing this round:\n<builder_report>\n${state.currentBuild?.summary ?? ""}\n</builder_report>\nCheck the real current state through the tools.`,
          tests: testsBlock,
          previous: previousBlock,
          dismissed: dismissedBlock,
        });
        const review = await this.withLimitPause(round, () =>
          runReviewer(this.context(this.roundDir(round), "reviewer"), prompt, workspace.reviewerServers),
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
        state.cursor = { round, step: state.manualReview ? "manual-review" : "judge-triage" };
      } else if (step === "judge-triage" || step === "manual-review") {
        const record = recordFor(round)!;
        const triage = step === "manual-review" ? await this.manualTriage(record) : await this.judgeTriage(record);
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
