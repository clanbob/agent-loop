export type WorkspaceSpec =
  | {
      kind: "folder";
      project: string;
      scope: string[];
      guides: string[];
      testCommand: string | null;
      branch: string;
      worktree: string;
    }
  | {
      kind: "roblox";
      scope: string[];
      guides: string[];
      testCommand: null;
    };

export interface BuilderSetup {
  mcpServers: Record<string, { command: string; args: string[] }>;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
}

export interface Workspace {
  spec: WorkspaceSpec;
  label: string;
  workDir: string;
  builder: BuilderSetup;
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
