import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const IDENTITY = ["-c", "user.name=agent-loop", "-c", "user.email=agent-loop@localhost"];

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.safecrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function ensureRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (existsSync(path.join(dir, ".git"))) return;
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "core.quotepath", "false"]);
  git(dir, [...IDENTITY, "commit", "-q", "--allow-empty", "-m", "mirror created"]);
}

export function head(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

export function commitAll(dir: string, message: string): { commit: string; changed: boolean } {
  git(dir, ["add", "-A"]);
  const status = git(dir, ["status", "--porcelain"]).trim();
  if (!status) return { commit: head(dir), changed: false };
  git(dir, [...IDENTITY, "commit", "-q", "-m", message]);
  return { commit: head(dir), changed: true };
}

export function diff(dir: string, from: string, to: string): string {
  return git(dir, ["diff", "--find-renames", from, to, "--", ".", ":(exclude)_manifest.json"]);
}

export function changedFiles(dir: string, from: string, to: string): string[] {
  return git(dir, ["diff", "--name-only", "--find-renames", from, to, "--", ".", ":(exclude)_manifest.json"])
    .split(/\r?\n/)
    .filter(Boolean);
}
