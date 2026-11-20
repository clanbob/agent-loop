import type { AgentChoices, LimitPause, PauseRequest, RunState, Step } from "../../src/loop.ts";
import type { ModelCatalog } from "../../src/models.ts";
import type { McpServer, McpServers, McpServerTest } from "../../src/mcp.ts";
import type { WorkspaceSpec } from "../../src/workspace/types.ts";
import type { Decision } from "../../src/agents/judge.ts";
import type { Finding } from "../../src/agents/types.ts";

export type { RunState, LimitPause, PauseRequest, Step, Decision, Finding, AgentChoices, ModelCatalog };
export type { AgentChoice } from "../../src/loop.ts";
export type { AgentModels, ModelOption } from "../../src/models.ts";
export type { McpServers, McpServerTest, McpServer } from "../../src/mcp.ts";
export type { RoundRecord, TimelineEntry, Phase, SkippedFinding } from "../../src/loop.ts";

export type RunKind = WorkspaceSpec["kind"];

export interface McpTool {
  id: string;
  name: string;
  server: McpServer;
  builtIn?: "roblox-studio";
}

export interface Environment {
  id: string;
  name: string;
  toolIds: string[];
  projectPath: string;
  notes: string;
  builtIn?: "project" | "roblox";
}

export interface Setup {
  tools: McpTool[];
  environments: Environment[];
}

export interface ToolInput {
  id: string | null;
  name: string;
  server: McpServer;
}

export interface EnvironmentInput {
  id: string | null;
  name: string;
  toolIds: string[];
  projectPath: string;
  notes: string;
}

export interface StartRequest {
  environmentId: string;
  project: string;
  task: string;
  scope: string[];
  test: string;
  guides: string[];
  agents: AgentChoices;
  manualReview?: boolean;
}

export interface ParsedServers {
  servers: McpServers;
  problems: string[];
  described: Array<{ name: string; summary: string }>;
}

export type PendingPause = { kind: "limit"; pause: LimitPause } | { kind: "confirm"; pause: PauseRequest } | { kind: "review"; round: number };

export type DisplayStatus = RunState["status"] | "interrupted";

export interface RunListItem {
  id: string;
  kind: RunKind;
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
  guides: string[];
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
  setReviewVerdict(id: string, round: number, finding: string, verdict: Decision["verdict"]): Promise<void>;
  submitReview(id: string, round: number): Promise<void>;
  setManualReview(id: string, on: boolean): Promise<void>;
  answerPause(id: string, yes: boolean): Promise<void>;
  deleteRun(id: string): Promise<ActionResult>;
  readDiff(id: string, round: number, which: "round" | "total"): Promise<string>;
  finishAction(id: string, action: "merge" | "discard"): Promise<ActionResult>;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  checkTools(): Promise<ToolStatus[]>;
  listModels(refresh?: boolean): Promise<ModelCatalog>;
  getSetup(): Promise<Setup>;
  saveTool(input: ToolInput): Promise<McpTool>;
  deleteTool(id: string): Promise<void>;
  saveEnvironment(input: EnvironmentInput): Promise<Environment>;
  deleteEnvironment(id: string): Promise<void>;
  parseMcp(text: string, name: string): Promise<ParsedServers>;
  testMcp(servers: McpServers): Promise<McpServerTest[]>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

export const IPC = {
  invoke: "agentloop:invoke",
  event: "agentloop:event",
} as const;

export type ApiMethod = Exclude<keyof AgentLoopApi, "onEvent">;
