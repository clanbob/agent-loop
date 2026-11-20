import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_GUIDES = 20;

function imports(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const dir = path.dirname(file);
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^@(\S+\.\w+)$/);
    if (!match) continue;
    const target = match[1].startsWith("~") ? path.join(os.homedir(), match[1].slice(1)) : path.resolve(dir, match[1]);
    found.push(target);
  }
  return found;
}

export function discoverGuides(): string[] {
  const start = path.join(os.homedir(), ".claude", "CLAUDE.md");
  if (!existsSync(start)) return [];

  const seen = new Set<string>();
  const queue = [start];
  const out: string[] = [];
  while (queue.length > 0 && out.length < MAX_GUIDES) {
    const file = queue.shift()!;
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    out.push(file);
    queue.push(...imports(file));
  }
  return out;
}

export function mergeGuides(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of lists.flat()) {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}
