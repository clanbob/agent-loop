import type { Config } from "../config.ts";
import { createFolderWorkspace } from "./folder.ts";
import { createRobloxWorkspace } from "./roblox.ts";
import { createToolsWorkspace } from "./tools.ts";
import type { Workspace, WorkspaceSpec } from "./types.ts";

export function createWorkspace(config: Config, spec: WorkspaceSpec): Workspace {
  if (spec.kind === "folder") return createFolderWorkspace(config, spec);
  if (spec.kind === "tools") return createToolsWorkspace(config, spec);
  return createRobloxWorkspace(config, spec);
}

export { folderSpec } from "./folder.ts";
export { robloxSpec } from "./roblox.ts";
export { toolsSpec } from "./tools.ts";
export type { Workspace, WorkspaceSpec } from "./types.ts";
