import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { discoverGuides, mergeGuides } from "../guides.ts";
import { mcpToolNames, scopeList, serverList, type EnvironmentSpec, type Workspace, type WorkspaceSpec } from "./types.ts";

type ToolsSpec = Extract<WorkspaceSpec, { kind: "tools" }>;

export function toolsSpec(config: Config, runId: string, scope: string[], guides: string[], environment: EnvironmentSpec): ToolsSpec {
  if (Object.keys(environment.servers).length === 0) {
    throw new Error(`The "${environment.name}" environment has no MCP tools and no project folder, so there is nothing to work in.`);
  }
  return {
    kind: "tools",
    scope,
    guides: mergeGuides(discoverGuides(), guides).map((g) => path.resolve(g)),
    testCommand: null,
    workDir: path.join(config.dataDir, "workspaces", runId),
    environment,
  };
}

export function createToolsWorkspace(_config: Config, spec: ToolsSpec): Workspace {
  const env = spec.environment;
  const servers = serverList(env.servers);
  const notes = env.notes.trim() ? `\nHow to use the tools:\n${env.notes.trim()}` : "";
  const focus = spec.scope.length > 0 ? `\nThe work should stay within:\n${scopeList(spec.scope, "")}` : "";
  let snapshots = 0;

  return {
    spec,
    label: `${env.name} (MCP tools only)`,
    workDir: spec.workDir,
    tracksChanges: false,
    reviewerServers: env.servers,
    builder: {
      mcpServers: env.servers,
      allowedTools: ["Read", "Grep", "Glob", ...mcpToolNames(env.servers)],
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash", "PowerShell"],
      addDirs: [],
    },
    notes: {
      judge: `This run has no project folder. The work happens in live apps or services that the builder reaches through these MCP tools:
${servers}${notes}${focus}
Refer to live items by name or ID. The builder and reviewer have access to the tools.`,
      builder: `This run has no project folder. Make every change through these MCP tools:
${servers}${notes}${focus}
Your working directory is an empty scratch folder; do not put the result there.
In your final report, say exactly what you created or changed and where (names, ids, paths inside the app), so the reviewer can find and check it.`,
      reviewer: `This run has no project folder and no diff. The work lives in live apps or services reached through these MCP tools:
${servers}${notes}${focus}
Use the tools ONLY to read and inspect. Never create, change, delete, run or save anything through them: you are the reviewer, not the builder.
Inspect the current state of the items named in the request or builder report.`,
    },

    async prepare() {
      mkdirSync(spec.workDir, { recursive: true });
      return "start";
    },

    async snapshot() {
      snapshots += 1;
      return `snapshot-${Date.now()}-${snapshots}`;
    },

    changedFiles() {
      return [];
    },

    diff() {
      return "";
    },

    outOfScope() {
      return [];
    },

    async finish(status) {
      if (status === "clean") rmSync(spec.workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      return status === "clean"
        ? `The changes were made live through the ${env.name} MCP tools; there is no branch to merge.`
        : `Any changes made so far were made live through the ${env.name} MCP tools.`;
    },
  };
}
