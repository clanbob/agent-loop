import type { DisplayStatus, Phase, TimelineEntry } from "../shared/api.ts";

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  running: "Running",
  clean: "Finished",
  stopped: "Stopped",
  failed: "Failed",
  interrupted: "Interrupted",
};

export const AGENT_LABEL: Record<string, string> = {
  judge: "Antigravity",
  claude: "Claude",
  codex: "Codex",
  loop: "Loop",
  setup: "Loop",
};

export function phaseLabel(phase: Phase, round: number): string {
  switch (phase) {
    case "prepare":
      return "Preparing workspace";
    case "judge":
      return round === 0 ? "Antigravity plans the work" : "Antigravity judges the findings";
    case "build":
      return "Claude builds";
    case "snapshot":
      return "Saving a snapshot";
    case "test":
      return "Running tests";
    case "review":
      return "Codex reviews";
    case "paused":
      return "Paused: out of usage";
    case "done":
      return "Done";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
  }
}

export const PHASE_AGENT: Partial<Record<Phase, string>> = {
  judge: "judge",
  build: "claude",
  review: "codex",
};

export function duration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export interface TimedStep {
  phase: Phase;
  round: number;
  start: number;
  end: number | null;
}

const TERMINAL: Phase[] = ["done", "stopped", "failed"];

export function timedSteps(timeline: TimelineEntry[], finishedAt: string | null): TimedStep[] {
  const steps: TimedStep[] = [];
  const end = finishedAt ? Date.parse(finishedAt) : null;
  timeline.forEach((entry, i) => {
    if (TERMINAL.includes(entry.phase)) return;
    const next = timeline[i + 1];
    steps.push({
      phase: entry.phase,
      round: entry.round,
      start: Date.parse(entry.at),
      end: next ? Date.parse(next.at) : end,
    });
  });
  return steps;
}

export function runTitle(task: string): string {
  return task.trim().split(/\r?\n/)[0] || "(no task)";
}

export function runDate(id: string): string {
  const iso = id.replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3Z");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return id;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}
