import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { git, commitAll, head, diff, changedFiles } from "../git.ts";
import { scopeFilter, scopeList, type Workspace, type WorkspaceSpec } from "./types.ts";

type FolderSpec = Extract<WorkspaceSpec, { kind: "folder" }>;

export function folderSpec(
  config: Config,
  runId: string,
  project: string,
  scope: string[],
  guides: string[],
  testCommand: string | null,
): FolderSpec {
  const resolved = path.resolve(project);
  if (!existsSync(resolved)) throw new Error(`Project folder not found: ${resolved}`);
  let top: string;
  try {
    top = git(resolved, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error(`${resolved} is not a git repository. Run "git init" and make a first commit there first.`);
  }
  try {
    git(top, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(`${top} has no commits yet. Make a first commit there first.`);
  }
  return {
    kind: "folder",
    project: path.resolve(top),
    scope: scope.map((s) => s.replace(/\\/g, "/").replace(/^\.\//, "")),
    guides: [...config.folder.guides, ...guides].map((g) => path.resolve(g)),
    testCommand,
    branch: `agentloop/${runId}`,
    worktree: path.join(config.root, "worktrees", runId),
  };
}

export function createFolderWorkspace(config: Config, spec: FolderSpec): Workspace {
  const scope = scopeList(spec.scope, "Anywhere in the project.");
  const where = `The project is ${spec.project}. This task works in a separate git worktree of it at ${spec.worktree}, on the branch ${spec.branch}.`;

  return {
    spec,
    label: `${spec.project} (branch ${spec.branch})`,
    workDir: spec.worktree,
    builder: {
      mcpServers: {},
      allowedTools: config.folder.builderTools,
      disallowedTools: [],
      addDirs: [],
    },
    notes: {
      judge: `${where}
Read the code there to understand the project and find what the builder should reuse; mention files by their path in the project.
Changes are allowed in:
${scope}`,
      builder: `${where}
Your working directory is that worktree. Make every change there, and only under:
${scope}
If the task truly needs a change elsewhere, do not make it: say so in your final report instead.
Do not commit, switch branches or touch other worktrees; the loop commits your work after each round.
You may run the project's build and tests to check your work.`,
      reviewer: `Your working folder is the project's code on the task's branch. Read any file you need, especially existing code the change uses, to check it is used correctly.
Changes were only allowed in:
${scope}`,
    },

    async prepare() {
      if (!existsSync(spec.worktree)) {
        mkdirSync(path.dirname(spec.worktree), { recursive: true });
        const branchExists = git(spec.project, ["branch", "--list", spec.branch]).trim() !== "";
        git(spec.project, branchExists
          ? ["worktree", "add", spec.worktree, spec.branch]
          : ["worktree", "add", "-b", spec.branch, spec.worktree, "HEAD"]);
      }
      return head(spec.worktree);
    },

    async snapshot(message) {
      return commitAll(spec.worktree, message).commit;
    },

    changedFiles(from, to) {
      return changedFiles(spec.worktree, from, to);
    },

    diff(from, to) {
      return diff(spec.worktree, from, to);
    },

    outOfScope(files) {
      return scopeFilter(spec.scope, files);
    },

    async finish(status) {
      if (status !== "clean") {
        return `The work so far is in ${spec.worktree} (branch ${spec.branch}).`;
      }
      try {
        git(spec.project, ["worktree", "remove", "--force", spec.worktree]);
      } catch {}
      return `The finished code is on branch ${spec.branch} in ${spec.project}.
To take it:     git -C "${spec.project}" merge ${spec.branch}
To throw it away: git -C "${spec.project}" branch -D ${spec.branch}`;
    },
  };
}
