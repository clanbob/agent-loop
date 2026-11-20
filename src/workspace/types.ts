import type { McpServer, McpServers } from "../mcp.ts";
import { describeServer } from "../mcp.ts";

export interface EnvironmentSpec {
  name: string;
  servers: McpServers;
  notes: string;
}

export type WorkspaceSpec =
  | {
      kind: "folder";
      project: string;
      scope: string[];
      guides: string[];
      testCommand: string | null;
      branch: string;
      worktree: string;
      environment?: EnvironmentSpec | null;
    }
  | {
      kind: "roblox";
      scope: string[];
      guides: string[];
      testCommand: null;
      studio?: McpServer | null;
      environment?: EnvironmentSpec | null;
    }
  | {
      kind: "tools";
      scope: string[];
      guides: string[];
      testCommand: null;
      workDir: string;
      environment: EnvironmentSpec;
    };

export interface BuilderSetup {
  mcpServers: McpServers;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
}

export interface Workspace {
  spec: WorkspaceSpec;
  label: string;
  workDir: string;
  builder: BuilderSetup;
  reviewerServers: McpServers;
  tracksChanges: boolean;
  notes: { judge: string; builder: string; reviewer: string };
  prepare(): Promise<string>;
  snapshot(message: string): Promise<string>;
  changedFiles(from: string, to: string): string[];
  diff(from: string, to: string): string;
  outOfScope(files: string[]): string[];
  finish(status: "clean" | "stopped" | "failed"): Promise<string | null>;
}

export function scopeFilter(prefixes: string[], files: string[]): string[] {
  if (prefixes.length === 0) return [];
  const lowered = prefixes.map((p) => p.toLowerCase().replace(/\/+$/, ""));
  return files.filter((file) => {
    const f = file.toLowerCase();
    return !lowered.some((p) => f === p || f.startsWith(`${p}/`) || f.startsWith(`${p}.`));
  });
}

export function scopeList(scope: string[], none: string): string {
  return scope.length === 0 ? none : scope.map((s) => `- ${s}`).join("\n");
}

export function serverList(servers: McpServers): string {
  return Object.entries(servers)
    .map(([name, server]) => `- ${name} (${describeServer(server)})`)
    .join("\n");
}

export function toolsNote(env: EnvironmentSpec | null | undefined, who: "builder" | "others"): string {
  if (!env || Object.keys(env.servers).length === 0) return "";
  const lead =
    who === "builder"
      ? `This run uses the "${env.name}" environment. You also have these MCP tools (their tool names start with mcp__<server>__):`
      : `This run uses the "${env.name}" environment. The builder also has these MCP tools:`;
  const notes = env.notes.trim() ? `\nHow to use them:\n${env.notes.trim()}` : "";
  return `\n${lead}\n${serverList(env.servers)}${notes}`;
}

export function mcpToolNames(servers: McpServers): string[] {
  return Object.keys(servers).map((name) => `mcp__${name}`);
}
