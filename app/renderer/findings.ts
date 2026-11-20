import type { Decision, Finding, RoundRecord } from "../shared/api.ts";

export interface Skipped {
  round: number;
  finding: Finding;
  reason: string;
}

export function skippedFindings(rounds: RoundRecord[]): Skipped[] {
  const out: Skipped[] = [];
  for (const record of rounds) {
    for (const d of record.decisions ?? []) {
      if (d.verdict !== "skip") continue;
      const finding = record.findings.find((f) => f.id === d.id);
      if (finding) out.push({ round: record.round, finding, reason: d.reason });
    }
  }
  return out;
}

export function decisionFor(record: RoundRecord, id: string): Decision | null {
  return record.decisions?.find((d) => d.id === id) ?? null;
}
