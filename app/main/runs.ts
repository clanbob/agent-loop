import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../src/config.ts";
import { AgentLoop, listRuns, newRunId, type LimitPause, type PauseRequest, type RunState } from "../../src/loop.ts";
import { folderSpec, robloxSpec, toolsSpec } from "../../src/workspace/index.ts";
import { git } from "../../src/git.ts";
import type { EnvironmentStore } from "./environments.ts";
import type {
  ActionResult,
  AppEvent,
  DisplayStatus,
  LogLine,
  PendingPause,
  RunDetail,
  RunListItem,
  StartRequest,
} from "../shared/api.ts";

const MAX_LOG_LINES = 4000;
const LOG_FLUSH_MS = 150;
const DELETE_RETRY_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

interface Tracked {
  state: RunState;
  loop: AgentLoop | null;
  pending: { pause: PendingPause; answer: (yes: boolean) => void } | null;
  logs: LogLine[];
  unsent: LogLine[];
  diffs: Map<string, string>;
  folderDeleted: boolean;
  finishDone: "merged" | "discarded" | null;
}

function titleOf(task: string): string {
  return task.trim().split(/\r?\n/)[0].slice(0, 120) || "(no task)";
}

function roundDirName(round: number): string {
  return `round-${String(round).padStart(2, "0")}`;
}

export class RunManager {
  private config: Config;
  private send: (event: AppEvent) => void;
  private tracked = new Map<string, Tracked>();
  private flushTimer: NodeJS.Timeout | null = null;
  private environments: EnvironmentStore;

  constructor(config: Config, send: (event: AppEvent) => void, environments: EnvironmentStore) {
    this.config = config;
    this.send = send;
    this.environments = environments;
  }

  private runDir(id: string): string {
    return path.join(this.config.dataDir, "runs", id);
  }

  private readDisk(id: string): RunState | null {
    const file = path.join(this.runDir(id), "run.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as RunState;
    } catch {
      return null;
    }
  }

  private displayStatus(state: RunState, live: boolean): DisplayStatus {
    if (state.status === "running" && !live) return "interrupted";
    return state.status;
  }

  get hasLiveRuns(): boolean {
    return [...this.tracked.values()].some((t) => t.loop);
  }

  list(): RunListItem[] {
    const items = new Map<string, RunListItem>();
    for (const summary of listRuns(this.config)) {
      if (this.tracked.has(summary.id)) continue;
      items.set(summary.id, {
        id: summary.id,
        kind: summary.kind,
        status: summary.alive ? "running" : summary.status === "running" ? "interrupted" : summary.status,
        live: false,
        paused: Boolean(summary.pausedFor),
        title: titleOf(summary.task),
        round: summary.round,
        step: summary.step,
        startedAt: null,
      });
    }
    for (const [id, t] of this.tracked) {
      items.set(id, {
        id,
        kind: t.state.workspace.kind,
        status: this.displayStatus(t.state, Boolean(t.loop)),
        live: Boolean(t.loop),
        paused: Boolean(t.pending),
        title: titleOf(t.state.task),
        round: t.state.cursor.round,
        step: t.state.cursor.step,
        startedAt: t.state.startedAt,
      });
    }
    return [...items.values()].sort((a, b) => b.id.localeCompare(a.id));
  }

  get(id: string): RunDetail | null {
    const t = this.tracked.get(id);
    if (t) {
      return {
        state: t.state,
        status: this.displayStatus(t.state, Boolean(t.loop)),
        live: Boolean(t.loop),
        pending: t.pending?.pause ?? null,
        folderDeleted: t.folderDeleted,
        logs: t.logs,
        finishDone: t.finishDone,
      };
    }
    const state = this.readDisk(id);
    if (!state) return null;
    return {
      state,
      status: this.displayStatus(state, false),
      live: false,
      pending: null,
      folderDeleted: false,
      logs: [],
      finishDone: null,
    };
  }

  private liveRobloxRun(): boolean {
    return [...this.tracked.values()].some((t) => t.loop && t.state.workspace.kind === "roblox");
  }

  start(request: StartRequest): { id: string } {
    const task = request.task.trim();
    if (!task) throw new Error("Write the task first.");
    const scope = request.scope.map((s) => s.trim()).filter(Boolean);
    const guides = request.guides.map((g) => g.trim()).filter(Boolean);
    const { env, studio, servers, all } = this.environments.resolve(request.environmentId);
    const project = request.project.trim();
    const kind = project ? "folder" : studio ? "roblox" : "tools";
    if (kind === "roblox" && this.liveRobloxRun()) {
      throw new Error("A Roblox Studio run is already going. Only one can edit the place at a time.");
    }
    if (kind === "tools" && Object.keys(servers).length === 0) {
      throw new Error(`Choose a project folder, or add MCP tools to the "${env.name}" environment.`);
    }
    const id = newRunId();
    if (this.tracked.has(id) || existsSync(this.runDir(id))) throw new Error("Wait a second before starting another run.");
    const envSpec = (s: typeof servers) => ({ name: env.name, servers: s, notes: env.notes });
    const spec =
      kind === "folder"
        ? folderSpec(this.config, id, project, scope, guides, request.test.trim() || null, Object.keys(all).length > 0 ? envSpec(all) : null)
        : kind === "roblox"
          ? robloxSpec(this.config, scope, guides, studio, Object.keys(servers).length > 0 ? envSpec(servers) : null)
          : toolsSpec(this.config, id, scope, guides, envSpec(servers));
    const loop = AgentLoop.start(this.config, id, task, spec, this.hooks(id), request.agents ?? null);
    this.attach(loop);
    return { id };
  }

  resume(id: string): void {
    const existing = this.tracked.get(id);
    if (existing?.loop) throw new Error("This run is already going.");
    const state = existing?.state ?? this.readDisk(id);
    if (state?.workspace.kind === "roblox" && this.liveRobloxRun()) {
      throw new Error("A Roblox Studio run is already going. Only one can edit the place at a time.");
    }
    const loop = AgentLoop.resume(this.config, id, this.hooks(id));
    this.attach(loop, existing?.logs);
  }

  stop(id: string): void {
    const t = this.tracked.get(id);
    if (!t?.loop) return;
    t.loop.stop();
    if (t.pending) this.answer(id, false);
  }

  stopAll(): void {
    for (const id of this.tracked.keys()) this.stop(id);
  }

  answer(id: string, yes: boolean): void {
    const t = this.tracked.get(id);
    if (!t?.pending) return;
    const { answer } = t.pending;
    t.pending = null;
    answer(yes);
    this.changed(id);
  }

  private hooks(id: string) {
    const wait = (pause: PendingPause, signal?: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        const t = this.tracked.get(id);
        if (!t) return resolve(false);
        t.pending = { pause, answer: resolve };
        signal?.addEventListener("abort", () => this.answer(id, false), { once: true });
        this.changed(id);
      });
    return {
      confirmContinue: (pause: PauseRequest) => wait({ kind: "confirm", pause }),
      waitForResume: (pause: LimitPause, signal: AbortSignal) => wait({ kind: "limit", pause }, signal),
    };
  }

  private attach(loop: AgentLoop, previousLogs: LogLine[] = []): void {
    const id = loop.state.id;
    const t: Tracked = {
      state: loop.state,
      loop,
      pending: null,
      logs: previousLogs,
      unsent: [],
      diffs: this.tracked.get(id)?.diffs ?? new Map(),
      folderDeleted: false,
      finishDone: null,
    };
    this.tracked.set(id, t);

    const log = (agent: string, text: string) => {
      const line = { at: Date.now(), agent, text };
      t.logs.push(line);
      if (t.logs.length > MAX_LOG_LINES) t.logs.splice(0, t.logs.length - MAX_LOG_LINES);
      t.unsent.push(line);
      this.scheduleFlush();
    };

    loop.on("phase", () => this.changed(id));
    loop.on("log", (message) => {
      log("loop", message);
      this.changed(id);
    });
    loop.on("agentLine", (agent, line) => log(agent, line));
    loop.on("round", (record) => {
      this.cacheDiffs(id, record.round);
      this.changed(id);
    });
    loop.on("triage", () => this.changed(id));
    loop.on("finished", (state) => {
      t.state = state;
      t.loop = null;
      t.pending = null;
      t.folderDeleted = loop.runFolderDeleted;
      if (!t.folderDeleted && this.shouldDeleteFolder(state)) this.retryDelete(id, 0);
      this.flush();
      this.changed(id);
    });

    this.send({ type: "runs" });
    loop.run().catch((err) => {
      log("loop", `Run crashed: ${(err as Error).message}`);
      t.loop = null;
      this.changed(id);
    });
  }

  private shouldDeleteFolder(state: RunState): boolean {
    const policy = this.config.deleteRunFolder;
    return policy === "always" || (policy === "onClean" && state.status === "clean");
  }

  private retryDelete(id: string, attempt: number): void {
    const delay = DELETE_RETRY_MS[attempt];
    if (delay === undefined) return;
    setTimeout(() => {
      try {
        rmSync(this.runDir(id), { recursive: true, force: true });
        const t = this.tracked.get(id);
        if (t) t.folderDeleted = true;
        this.changed(id);
      } catch {
        this.retryDelete(id, attempt + 1);
      }
    }, delay);
  }

  sweepFinishedFolders(): void {
    for (const summary of listRuns(this.config)) {
      if (summary.alive || this.tracked.has(summary.id)) continue;
      const state = this.readDisk(summary.id);
      if (!state || state.status === "running" || !this.shouldDeleteFolder(state)) continue;
      try {
        rmSync(this.runDir(summary.id), { recursive: true, force: true });
      } catch {}
    }
  }

  private cacheDiffs(id: string, round: number): void {
    const t = this.tracked.get(id);
    if (!t) return;
    for (const which of ["round", "total"] as const) {
      const file = path.join(this.runDir(id), roundDirName(round), which === "round" ? "round-diff.patch" : "diff.patch");
      if (existsSync(file)) t.diffs.set(`${round}:${which}`, readFileSync(file, "utf8"));
    }
  }

  readDiff(id: string, round: number, which: "round" | "total"): string {
    const cached = this.tracked.get(id)?.diffs.get(`${round}:${which}`);
    if (cached !== undefined) return cached;
    const file = path.join(this.runDir(id), roundDirName(round), which === "round" ? "round-diff.patch" : "diff.patch");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  delete(id: string): ActionResult {
    const t = this.tracked.get(id);
    if (t?.loop) return { ok: false, message: "Stop the run before deleting it." };
    const state = t?.state ?? this.readDisk(id);
    const notes: string[] = [];
    if (state?.workspace.kind === "folder") {
      const { project, worktree, branch } = state.workspace;
      if (existsSync(worktree)) {
        try {
          git(project, ["worktree", "remove", "--force", worktree]);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
      }
      try {
        git(project, ["worktree", "prune"]);
        git(project, ["branch", "-D", branch]);
        notes.push(`Deleted branch ${branch}.`);
      } catch {}
    }
    rmSync(this.runDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    this.tracked.delete(id);
    this.send({ type: "runs" });
    return { ok: true, message: ["Run deleted.", ...notes].join(" ") };
  }

  finishAction(id: string, action: "merge" | "discard"): ActionResult {
    const t = this.tracked.get(id);
    const state = t?.state ?? this.readDisk(id);
    if (!state || state.workspace.kind !== "folder") return { ok: false, message: "Only project runs have a branch." };
    const { project, branch, worktree } = state.workspace;
    try {
      if (action === "merge") {
        const out = git(project, ["merge", "--no-edit", branch]);
        if (t) t.finishDone = "merged";
        this.changed(id);
        return { ok: true, message: out.trim() || `Merged ${branch}.` };
      }
      if (existsSync(worktree)) git(project, ["worktree", "remove", "--force", worktree]);
      git(project, ["branch", "-D", branch]);
      if (t) t.finishDone = "discarded";
      this.changed(id);
      return { ok: true, message: `Deleted branch ${branch}.` };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message: string };
      return { ok: false, message: (e.stderr || e.stdout || e.message).trim() };
    }
  }

  private changed(id: string): void {
    this.send({ type: "run", id });
    this.send({ type: "runs" });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), LOG_FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [id, t] of this.tracked) {
      if (t.unsent.length === 0) continue;
      this.send({ type: "log", id, lines: t.unsent });
      t.unsent = [];
    }
  }
}
