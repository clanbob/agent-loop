import type { Config } from "../config.ts";

export interface Finding {
  id: string;
  severity: "high" | "medium" | "low";
  file: string;
  line: number | null;
  issue: string;
  suggestion: string;
  repeat_of: string | null;
}

export interface Review {
  summary: string;
  findings: Finding[];
}

export interface StepContext {
  config: Config;
  runDir: string;
  roundDir: string;
  workDir: string;
  guides: string[];
  signal: AbortSignal;
  onLine?: (line: string) => void;
}

export interface UsageLimit {
  resetAt: Date | null;
  message: string;
}

export class AgentError extends Error {
  agent: string;
  logFile: string;
  limit: UsageLimit | null;
  noSession: boolean;

  constructor(agent: string, message: string, logFile: string, extra?: { limit?: UsageLimit; noSession?: boolean }) {
    super(`${agent}: ${message} (log: ${logFile})`);
    this.agent = agent;
    this.logFile = logFile;
    this.limit = extra?.limit ?? null;
    this.noSession = extra?.noSession ?? false;
  }
}

const LIMIT_PATTERNS = [
  /usage limit/i,
  /limit reached/i,
  /hit your (?:\w+ )?limit/i,
  /rate[ -]?limit/i,
  /RESOURCE_EXHAUSTED/,
  /quota (?:exceeded|exhausted)/i,
  /exhausted your (?:\w+ )?(?:quota|capacity)/i,
  /out of (?:credits|usage)/i,
  /too many requests/i,
  /\b429\b/,
];

function parseResetTime(text: string, now: Date): Date | null {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);

  const iso = text.match(/reset\w*[^0-9]{0,20}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (iso) {
    const date = new Date(iso[1]);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const span = text.match(
    /(?:try again|retry|resets?|available)\s+in\s+(?:(\d+)\s*(?:days?|d)\b\s*,?\s*(?:and\s+)?)?(?:(\d+)\s*(?:hours?|hrs?|h)\b\s*,?\s*(?:and\s+)?)?(?:(\d+)\s*(?:minutes?|mins?|m)\b\s*,?\s*(?:and\s+)?)?(?:(\d+)\s*(?:seconds?|secs?|s)\b)?/i,
  );
  if (span && (span[1] || span[2] || span[3] || span[4])) {
    const ms = ((+(span[1] ?? 0) * 24 + +(span[2] ?? 0)) * 60 + +(span[3] ?? 0)) * 60_000 + +(span[4] ?? 0) * 1000;
    return new Date(now.getTime() + ms);
  }

  const clock = text.match(/(?:resets?|try again|available)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (clock) {
    let hour = +clock[1] % 12;
    if (clock[3].toLowerCase() === "pm") hour += 12;
    const date = new Date(now);
    date.setHours(hour, +(clock[2] ?? 0), 0, 0);
    if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
    return date;
  }

  return null;
}

export function detectUsageLimit(output: string, now = new Date()): UsageLimit | null {
  if (!LIMIT_PATTERNS.some((p) => p.test(output))) return null;
  const line =
    output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => LIMIT_PATTERNS.some((p) => p.test(l))) ?? "";
  return { resetAt: parseResetTime(output, now), message: line.slice(0, 300) };
}

export function failure(agent: string, reason: string, logFile: string, output: string): AgentError {
  const limit = detectUsageLimit(output);
  if (limit) return new AgentError(agent, `hit its usage limit: ${limit.message}`, logFile, { limit });
  return new AgentError(agent, reason, logFile);
}

export function extractJson<T>(text: string, requiredKey: string): T {
  const candidates: string[] = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && requiredKey in parsed) return parsed as T;
      for (const value of Object.values(parsed ?? {})) {
        if (typeof value === "string") {
          try {
            const inner = JSON.parse(value);
            if (inner && typeof inner === "object" && requiredKey in inner) return inner as T;
          } catch {}
        } else if (value && typeof value === "object" && requiredKey in (value as object)) {
          return value as T;
        }
      }
    } catch {}
  }
  throw new Error(`No JSON object with "${requiredKey}" found in output`);
}
