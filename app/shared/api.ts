import type { AgentChoices, LimitPause, PauseRequest, RunState, Step } from "../../src/loop.ts";
import type { ModelCatalog } from "../../src/models.ts";
import type { Decision } from "../../src/agents/judge.ts";
import type { Finding } from "../../src/agents/types.ts";

export type { RunState, LimitPause, PauseRequest, Step, Decision, Finding, AgentChoices, ModelCatalog };
export type { AgentChoice } from "../../src/loop.ts";
export type { AgentModels, ModelOption } from "../../src/models.ts";
export type { RoundRecord, TimelineEntry, Phase, SkippedFinding } from "../../src/loop.ts";

export type Target = "folder" | "roblox";

export interface StartRequest {
  target: Target;
  project: string;
  task: string;
  scope: string[];
  test: string;
  guides: string[];
  agents: AgentChoices;
}

export type PendingPause = { kind: "limit"; pause: LimitPause } | { kind: "confirm"; pause: PauseRequest };

export type DisplayStatus = RunState["status"] | "interrupted";

export interface RunListItem {
  id: string;
  kind: Target;
  status: DisplayStatus;
  live: boolean;
  paused: boolean;
  title: string;
  round: number;
  step: Step;
  startedAt: string | null;
}

export interface LogLine {
  at: number;
  agent: string;
  text: string;
}

export interface RunDetail {
  state: RunState;
  status: DisplayStatus;
  live: boolean;
  pending: PendingPause | null;
  folderDeleted: boolean;
  logs: LogLine[];
  finishDone: "merged" | "discarded" | null;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface ToolStatus {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AppInfo {
  judgeModel: string | null;
  robloxGuides: string[];
  folderGuides: string[];
}

export type AppEvent =
  | { type: "runs" }
  | { type: "run"; id: string }
  | { type: "log"; id: string; lines: LogLine[] };

export interface AgentLoopApi {
  info(): Promise<AppInfo>;
  listRuns(): Promise<RunListItem[]>;
  getRun(id: string): Promise<RunDetail | null>;
  startRun(request: StartRequest): Promise<{ id: string }>;
  resumeRun(id: string): Promise<void>;
  stopRun(id: string): Promise<void>;
  answerPause(id: string, yes: boolean): Promise<void>;
  deleteRun(id: string): Promise<ActionResult>;
  readDiff(id: string, round: number, which: "round" | "total"): Promise<string>;
  finishAction(id: string, action: "merge" | "discard"): Promise<ActionResult>;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  checkTools(): Promise<ToolStatus[]>;
  listModels(refresh?: boolean): Promise<ModelCatalog>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

export const IPC = {
  invoke: "agentloop:invoke",
  event: "agentloop:event",
} as const;

export type ApiMethod = Exclude<keyof AgentLoopApi, "onEvent">;
