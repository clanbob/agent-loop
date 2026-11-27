import { ChevronRight } from "lucide-react";
import type { Decision, RoundRecord, RunState } from "../shared/api.ts";
import { PHASE_AGENT, SEVERITY_LABEL, duration, phaseLabel, type TimedStep } from "./format.ts";
import { decisionFor } from "./findings.ts";

interface ReviewControls {
  round: number;
  busy: boolean;
  choose: (id: string, verdict: Decision["verdict"]) => void;
  submit: () => void;
}

const WAITING = new Set(["paused", "manual-review"]);

function stepKind(step: TimedStep): string {
  if (WAITING.has(step.phase)) return "wait";
  return PHASE_AGENT[step.phase] ?? "loop";
}

export function RoundsTab({ state, steps, live, now, review }: {
  state: RunState; steps: TimedStep[]; live: boolean; now: number; review: ReviewControls | null;
}) {
  const roundNumbers = new Set<number>([0, ...steps.map((s) => s.round), ...state.rounds.map((r) => r.round)]);
  const rounds = [...roundNumbers].sort((a, b) => b - a);

  return (
    <div className="rounds">
      {rounds.map((n) => {
        const record = state.rounds.find((r) => r.round === n) ?? null;
        const roundSteps = steps.filter((s) => s.round === n);
        const manual = record?.decisions
          ? record.reviewedBy === "you" || (!record.reviewedBy && Boolean(state.manualReview))
          : state.cursor.round === n && state.cursor.step === "manual-review";
        return <RoundCard key={n} round={n} record={record} manual={manual} controls={review?.round === n ? review : null} steps={roundSteps} live={live} now={now} />;
      })}
    </div>
  );
}

function RoundCard({
  round,
  record,
  manual,
  controls,
  steps,
  live,
  now,
}: {
  round: number;
  record: RoundRecord | null;
  manual: boolean;
  controls: ReviewControls | null;
  steps: TimedStep[];
  live: boolean;
  now: number;
}) {
  const timed = steps.map((s) => {
    const open = s.end === null && live;
    return { step: s, open, ms: Math.max((s.end ?? (open ? now : s.start)) - s.start, 0) };
  });
  const total = timed.reduce((sum, t) => sum + t.ms, 0);
  const fixes = record?.decisions?.filter((d) => d.verdict === "fix").length ?? null;

  const draft = new Map(record?.reviewDraft?.map((d) => [d.id, d.verdict]));
  const selected = [...draft.values()].filter((v) => v === "fix").length;

  return (
    <article className="card round-card">
      <div className="card-head">
        <h2>{round === 0 ? "Setup" : `Round ${round}`}</h2>
        <div className="round-summary">
          {record && (
            <span>
              {record.findings.length} finding{record.findings.length === 1 ? "" : "s"}
              {fixes !== null && ` · ${fixes} to fix · ${record.findings.length - fixes} skipped`}
            </span>
          )}
          {record?.testExitCode !== null && record?.testExitCode !== undefined && (
            <span className={record.testExitCode === 0 ? "ok-text" : "error-text"}>
              Tests {record.testExitCode === 0 ? "passed" : "failed"}
            </span>
          )}
          {total > 0 && <span className="mono">{duration(total)}</span>}
        </div>
      </div>

      {total > 0 && (
        <div className="strip" role="img" aria-label={`Time spent in ${round === 0 ? "setup" : `round ${round}`}, by step`}>
          {timed.map(({ step, open, ms }, i) => (
            <span
              key={i}
              className={`strip-seg strip-${stepKind(step)}${open ? " open" : ""}`}
              style={{ flexGrow: ms }}
              title={`${phaseLabel(step.phase, step.round)} · ${duration(ms)}`}
            />
          ))}
        </div>
      )}

      {timed.length > 0 && (
        <ol className="steps">
          {timed.map(({ step, open, ms }, i) => {
            const running = open && !WAITING.has(step.phase);
            const kind = stepKind(step);
            return (
              <li key={i} className={running ? "running" : ""}>
                <span className={`role-key role-${kind}`} />
                <span className="step-label">{phaseLabel(step.phase, step.round)}</span>
                <span className="step-time">
                  {running && <span className="spinner small" aria-hidden />}
                  {duration(ms)}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {record && (record.changedFiles.length > 0 || record.builderSummary) && (
        <div className="round-notes">
          {record.changedFiles.length > 0 && (
            <p className="changed">
              <span className="muted">Changed</span>
              {record.changedFiles.slice(0, 6).map((file) => (
                <code key={file}>{file}</code>
              ))}
              {record.changedFiles.length > 6 && <span className="muted">and {record.changedFiles.length - 6} more</span>}
            </p>
          )}
          {record.builderSummary && (
            <details className="report">
              <summary>
                <ChevronRight className="disclosure" />
                Builder report
              </summary>
              <pre className="prose-pre">{record.builderSummary}</pre>
            </details>
          )}
        </div>
      )}

      {record && record.findings.length > 0 && (
        <table className="findings">
          <thead>
            <tr>
              <th>Finding</th>
              <th>Where</th>
              <th>{manual ? "Your decision" : "Judge"}</th>
            </tr>
          </thead>
          <tbody>
            {record.findings.map((f) => {
              const decision = decisionFor(record, f.id);
              return (
                <tr key={f.id}>
                  <td>
                    <span className={`sev sev-${f.severity}`}>{SEVERITY_LABEL[f.severity] ?? f.severity}</span>
                    <div className="finding-issue">{f.issue}</div>
                    {f.suggestion && <div className="muted small">{f.suggestion}</div>}
                  </td>
                  <td className="where">
                    <code>
                      {f.file}
                      {f.line ? `:${f.line}` : ""}
                    </code>
                  </td>
                  <td className="verdict-cell">
                    {controls ? (
                      <div className="review-verdict" role="group" aria-label={`Decision for ${f.id}`}>
                        {(["fix", "skip"] as const).map((verdict) => (
                          <button key={verdict} className={`btn btn-small ${draft.get(f.id) === verdict ? "btn-primary" : ""}`}
                            aria-pressed={draft.get(f.id) === verdict} disabled={controls.busy}
                            onClick={() => controls.choose(f.id, verdict)}>
                            {verdict === "fix" ? "Fix" : "Skip"}
                          </button>
                        ))}
                      </div>
                    ) : decision ? (
                      <>
                        <span className={`verdict verdict-${decision.verdict}`}>{decision.verdict === "fix" ? "Fix" : "Skip"}</span>
                        <div className="muted small">{decision.reason}</div>
                      </>
                    ) : (
                      <span className="muted small">{manual ? draft.get(f.id) ?? "Awaiting your review" : "Waiting for the judge"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {controls && record && (
        <div className="review-submit">
          <span className="muted small" aria-live="polite">{draft.size} of {record.findings.length} findings marked</span>
          <button className="btn btn-primary" disabled={controls.busy || draft.size !== record.findings.length} onClick={controls.submit}>
            {draft.size === record.findings.length && selected === 0 ? "Finish run" : "Send fixes to builder"}
          </button>
        </div>
      )}
      {record && record.findings.length === 0 && <p className="ok-text round-clean">The reviewer reported no findings</p>}
    </article>
  );
}
