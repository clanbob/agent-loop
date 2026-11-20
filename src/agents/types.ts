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
  mirrorDir: string;
  signal: AbortSignal;
  onLine?: (line: string) => void;
}

export class AgentError extends Error {
  agent: string;
  logFile: string;

  constructor(agent: string, message: string, logFile: string) {
    super(`${agent}: ${message} (log: ${logFile})`);
    this.agent = agent;
    this.logFile = logFile;
  }
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
