import type { Config } from "../config.ts";
import { createFolderWorkspace } from "./folder.ts";
import { createRobloxWorkspace } from "./roblox.ts";
import type { Workspace, WorkspaceSpec } from "./types.ts";

export function createWorkspace(config: Config, spec: WorkspaceSpec): Workspace {
  return spec.kind === "folder" ? createFolderWorkspace(config, spec) : createRobloxWorkspace(config, spec);
}

export { folderSpec } from "./folder.ts";
export { robloxSpec } from "./roblox.ts";
export type { Workspace, WorkspaceSpec } from "./types.ts";
