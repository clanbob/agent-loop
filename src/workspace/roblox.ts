import path from "node:path";
import type { Config } from "../config.ts";
import { exportPlace, mirrorDirFor, safeName } from "../studio/exporter.ts";
import { diff, changedFiles } from "../git.ts";
import { scopeFilter, scopeList, type Workspace, type WorkspaceSpec } from "./types.ts";

type RobloxSpec = Extract<WorkspaceSpec, { kind: "roblox" }>;

export function robloxSpec(config: Config, scope: string[], guides: string[]): RobloxSpec {
  if (scope.length === 0) {
    throw new Error("Roblox runs need at least one --scope Studio path, e.g. --scope ServerScriptService/Combat");
  }
  return {
    kind: "roblox",
    scope,
    guides: [...config.roblox.guides, ...guides.map((g) => path.resolve(g))],
    testCommand: null,
  };
}

export function createRobloxWorkspace(config: Config, spec: RobloxSpec): Workspace {
  const mirrorDir = mirrorDirFor(config);
  const scope = scopeList(spec.scope, "");
  const prefixes = spec.scope.map((s) =>
    s
      .split(/[/.\\]/)
      .filter(Boolean)
      .map((seg) => safeName(seg, 1))
      .join("/"),
  );
  const mirrorNote = `A read-only copy of every script in the place is in ${mirrorDir}, one file per script, laid out by Studio explorer path. ".server.luau" is a Script, ".client.luau" a LocalScript, plain ".luau" a ModuleScript, and a folder with the same name as a script holds that script's children.`;

  return {
    spec,
    label: `Roblox Studio place ${config.roblox.placeId ?? ""}`.trim(),
    workDir: mirrorDir,
    builder: {
      mcpServers: { Roblox_Studio: { command: config.roblox.mcpCommand, args: config.roblox.mcpArgs } },
      allowedTools: ["mcp__Roblox_Studio", "Read", "Grep", "Glob"],
      disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash", "PowerShell"],
      addDirs: [],
    },
    notes: {
      judge: `The code is a Roblox (Luau) game that lives in an open Roblox Studio place. The builder edits it live in Studio.
${mirrorNote}
Look at it to find the existing modules the builder should reuse, and name scripts by their Studio path.
The builder may only create or edit scripts under these Studio locations:
${scope}`,
      builder: `The code is a Roblox (Luau) game in the open Roblox Studio place. This run was started by the user, and starting it is their approval to create and edit scripts in the place for this task, but only under these Studio locations:
${scope}
Do not create, edit or delete anything outside them. If the task truly needs a change elsewhere, do not make it: say so in your final report instead.
Make every change in Studio through the Roblox_Studio tools. ${mirrorNote} You may read it to find existing code, but editing it does nothing.
You may start a play test to check your work, but always stop it again and leave Studio in Edit mode when you finish.
In your final report, name every script you created, edited or deleted by its Studio path.`,
      reviewer: `The code is a Roblox (Luau) game. Your working folder is a read-only snapshot of every script in the place, one file per script, laid out by Studio explorer path. ".server.luau" is a Script, ".client.luau" a LocalScript, plain ".luau" a ModuleScript. A folder with the same name as a script holds that script's children. Read any file you need, especially the existing modules the new code uses, to check that it calls their real API.
The code was only allowed to change scripts under:
${scope}`,
    },

    async prepare() {
      return (await exportPlace(config, "before task")).commit;
    },

    async snapshot(message) {
      return (await exportPlace(config, message)).commit;
    },

    changedFiles(from, to) {
      return changedFiles(mirrorDir, from, to);
    },

    diff(from, to) {
      return diff(mirrorDir, from, to);
    },

    outOfScope(files) {
      return scopeFilter(prefixes, files);
    },

    async finish(status) {
      return status === "clean"
        ? "The changes are in your open Studio place. Save the place in Studio to keep them."
        : "Any changes made so far are in your open Studio place.";
    },
  };
}
