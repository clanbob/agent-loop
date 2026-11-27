import { Fragment, useEffect, useState } from "react";
import { Check, ChevronRight, CircleAlert, CircleCheck, CirclePause, CircleStop, CircleX, Play, Square, Trash2, TriangleAlert } from "lucide-react";
import type { LogLine, RunDetail } from "../shared/api.ts";
import { DEFAULT_CHOICES, PROVIDER_NAMES } from "../../src/roles.ts";
import { api, errorText } from "./api.ts";
import { PHASE_AGENT, SEVERITY_LABEL, STATUS_LABEL, basename, clockTime, duration, phaseLabel, runDate, runTitle, timedSteps } from "./format.ts";
import { RoundsTab } from "./RoundsTab.tsx";
import { OutputTab } from "./OutputTab.tsx";
import { ChangesTab } from "./ChangesTab.tsx";
import { skippedFindings } from "./findings.ts";
import { Segmented } from "./Segmented.tsx";
import { Switch } from "./Switch.tsx";

const TABS = [
  ["rounds", "Rounds"],
  ["output", "Live output"],
  ["changes", "Changes"],
  ["task", "Task"],
] as const;

type Tab = (typeof TABS)[number][0];

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function RunView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [detail, setDetail] = useState<RunDetail | null | undefined>(undefined);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [tab, setTab] = useState<Tab>("rounds");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.getRun(id).then((d) => {
        if (!alive) return;
        setDetail(d);
        if (d) setLogs(d.logs);
      });
    load();
    const off = api.onEvent((event) => {
      if (event.type === "run" && event.id === id) load();
      if (event.type === "log" && event.id === id) setLogs((prev) => [...prev, ...event.lines].slice(-4000));
    });
    return () => {
      alive = false;
      off();
    };
  }, [id]);

  const now = useNow(Boolean(detail?.live));

  if (detail === undefined) return <div className="page muted">Loading run</div>;
  if (detail === null) return <div className="page muted">This run no longer exists.</div>;

  const { state, status, live, pending } = detail;
  const steps = timedSteps(state.timeline ?? [], state.finishedAt);
  const current = live ? steps[steps.length - 1] : null;
  const currentAgent = current ? PHASE_AGENT[current.phase] : undefined;
  const started = steps[0]?.start ?? Date.parse(state.startedAt);
  const ended = state.finishedAt ? Date.parse(state.finishedAt) : now;
  const displayStatus = pending ? "paused" : status;

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await fn();
      const r = result as { ok?: boolean; message?: string } | undefined;
      if (r && typeof r.ok === "boolean") setNotice({ ok: r.ok, text: r.message ?? "" });
      else if (success) setNotice({ ok: true, text: success });
    } catch (err) {
      setNotice({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const branchNote =
      state.workspace.kind === "folder" ? ` This also deletes the branch ${state.workspace.branch} and any work on it.` : "";
    if (!window.confirm(`Delete this run?${branchNote}`)) return;
    setBusy(true);
    try {
      await api.deleteRun(id);
      onDeleted();
    } catch (err) {
      setNotice({ ok: false, text: errorText(err) });
      setBusy(false);
    }
  };

  const target =
    state.workspace.kind === "folder"
      ? basename(state.workspace.project)
      : state.workspace.kind === "tools"
        ? `${state.workspace.environment.name} (MCP tools)`
        : "Roblox Studio";
  const envTools = Object.keys(state.workspace.environment?.servers ?? {});

  return (
    <div className="run">
      <header className="run-head">
        <div className="run-head-text">
          <h1 title={state.task}>{runTitle(state.task)}</h1>
          <div className="run-meta">
            <span className="status">
              <span className={`dot dot-${displayStatus}`} />
              {pending ? "Paused" : STATUS_LABEL[status]}
            </span>
            <span>{target}</span>
            {state.startMode && (
              <span className="start-mode" title={state.startReason ?? undefined}>
                Started with {state.startMode}
              </span>
            )}
            <span className="mono">Round {Math.max(state.cursor.round, 1)}</span>
            <span className="mono">{duration(ended - started)}</span>
            <span className="muted">{runDate(state.id)}</span>
          </div>
        </div>
        <div className="run-head-actions">
          {live && (
            <Switch checked={Boolean(state.manualReview)} disabled={busy} label="Manual review"
              title={state.manualReview
                ? "You rule Fix or Skip on each finding. Turn off to hand the rulings back to the judge."
                : "The judge rules on each finding. Turn on to rule on them yourself; a ruling already in progress is handed to you."}
              onChange={(on) => act(() => api.setManualReview(id, on))} />
          )}
          {live && (
            <button className="btn btn-danger" disabled={busy} onClick={() => act(() => api.stopRun(id))}>
              <Square />
              Stop
            </button>
          )}
          {!live && status !== "clean" && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.resumeRun(id))}>
              <Play />
              Resume
            </button>
          )}
          {!live && (
            <button className="btn btn-ghost" disabled={busy} onClick={remove}>
              <Trash2 />
              Delete
            </button>
          )}
        </div>
      </header>

      {current && !pending && (
        <div className="now">
          {currentAgent ? <span className={`role-key role-${currentAgent}`} /> : <span className="role-key" />}
          <span className="now-label">{phaseLabel(current.phase, current.round)}</span>
          <span className="spinner" aria-hidden />
          <span className="now-time">{duration(now - current.start)}</span>
        </div>
      )}

      {pending?.kind === "review" && (
        <div className="banner banner-warn">
          <CirclePause className="banner-icon" />
          <div className="banner-body">
            <strong>Round {pending.round} is waiting for your review</strong>
            <p>Mark each finding Fix or Skip, then send the fixes to the builder.</p>
          </div>
          {tab !== "rounds" && (
            <div className="banner-actions">
              <button className="btn" onClick={() => setTab("rounds")}>Review findings</button>
            </div>
          )}
        </div>
      )}

      {pending?.kind === "limit" && (
        <div className="banner banner-warn">
          <CirclePause className="banner-icon" />
          <div className="banner-body">
            <strong>{pending.pause.agent} is out of usage</strong>
            {pending.pause.message && <p className="muted">{pending.pause.message}</p>}
            <p>
              {pending.pause.resetAt
                ? `Its limit resets around ${clockTime(pending.pause.resetAt)}.`
                : "It did not say when its limit resets."}{" "}
              The run waits until you resume it; you can also close the app and resume later.
            </p>
          </div>
          <div className="banner-actions">
            <button className="btn btn-primary" onClick={() => act(() => api.answerPause(id, true))}>
              Resume now
            </button>
            <button className="btn" onClick={() => act(() => api.answerPause(id, false))}>
              Stop run
            </button>
          </div>
        </div>
      )}

      {pending?.kind === "confirm" && (
        <div className="banner banner-warn">
          <TriangleAlert className="banner-icon" />
          <div className="banner-body">
            <strong>{pending.pause.reason}</strong>
            {pending.pause.details.length > 0 && (
              <ul className="banner-list">
                {pending.pause.details.slice(0, 12).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
                {pending.pause.details.length > 12 && <li className="muted">and {pending.pause.details.length - 12} more</li>}
              </ul>
            )}
          </div>
          <div className="banner-actions">
            <button className="btn btn-primary" onClick={() => act(() => api.answerPause(id, true))}>
              Continue
            </button>
            <button className="btn" onClick={() => act(() => api.answerPause(id, false))}>
              Stop run
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className={`banner ${notice.ok ? "banner-ok" : "banner-error"}`}>
          {notice.ok ? <Check className="banner-icon" /> : <CircleAlert className="banner-icon" />}
          <div className="banner-body">{notice.text}</div>
        </div>
      )}

      {!live && <Outcome detail={detail} busy={busy} onAction={(a) => act(() => api.finishAction(id, a))} />}

      <div className="tabs-row">
        <Segmented variant="tabs" label="Run sections" options={TABS} value={tab} onChange={setTab} />
      </div>

      <section className="tab-body">
        {tab === "rounds" && <RoundsTab state={state} steps={steps} live={live} now={now}
          review={pending?.kind === "review" ? {
            round: pending.round, busy,
            choose: (finding, verdict) => act(() => api.setReviewVerdict(id, pending.round, finding, verdict)),
            submit: () => act(() => api.submitReview(id, pending.round)),
          } : null} />}
        {tab === "output" && <OutputTab logs={logs} live={live} />}
        {tab === "changes" && <ChangesTab id={id} state={state} />}
        {tab === "task" && (
          <div className="task-tab">
            <section>
              <h3>Task</h3>
              <pre className="prose-pre">{state.task}</pre>
            </section>
            {state.startMode && (
              <section>
                <h3>Starting point</h3>
                <p className="prose-pre">
                  {state.startMode === "review"
                    ? "The reviewer inspected the existing code first."
                    : "The builder made changes before the first review."}
                  {state.startReason && <span className="muted"> {state.startReason}</span>}
                </p>
              </section>
            )}
            {state.instructions && (
              <section>
                <h3>Latest instructions</h3>
                <pre className="prose-pre">{state.instructions}</pre>
              </section>
            )}
            <section>
              <h3>Workspace</h3>
              {state.workspace.kind === "folder" ? (
                <dl className="kv">
                  <dt>Project</dt>
                  <dd className="mono">{state.workspace.project}</dd>
                  <dt>Branch</dt>
                  <dd className="mono">{state.workspace.branch}</dd>
                  <dt>Scope</dt>
                  <dd className="mono">{state.workspace.scope.join(", ") || "Anywhere"}</dd>
                  <dt>Tests</dt>
                  <dd className="mono">{state.workspace.testCommand ?? "None"}</dd>
                </dl>
              ) : state.workspace.kind === "tools" ? (
                <dl className="kv">
                  <dt>Works in</dt>
                  <dd>Live, through MCP tools only</dd>
                  <dt>Focus</dt>
                  <dd>{state.workspace.scope.join(", ") || "Not set"}</dd>
                </dl>
              ) : (
                <dl className="kv">
                  <dt>Target</dt>
                  <dd>Open Roblox Studio place</dd>
                  <dt>Scope</dt>
                  <dd className="mono">{state.workspace.scope.join(", ")}</dd>
                </dl>
              )}
            </section>
            {state.workspace.environment && (
              <section>
                <h3>Environment</h3>
                <dl className="kv">
                  <dt>Name</dt>
                  <dd>{state.workspace.environment.name}</dd>
                  <dt>MCP tools</dt>
                  <dd>{envTools.join(", ") || "None"}</dd>
                </dl>
              </section>
            )}
            <section>
              <h3>Models</h3>
              <dl className="kv">
                {(
                  [
                    ["Judge", "judge"],
                    ["Builder", "builder"],
                    ["Reviewer", "reviewer"],
                  ] as const
                ).map(([name, key]) => {
                  const choice = state.agents?.[key];
                  return (
                    <Fragment key={key}>
                      <dt>
                        <span className={`role-key role-${key}`} />
                        {name}
                      </dt>
                      <dd>
                        {PROVIDER_NAMES[choice?.provider ?? DEFAULT_CHOICES[key].provider]} · {choice?.model ?? "default model"}
                        {choice?.effort ? ` · effort ${choice.effort}` : ""}
                      </dd>
                    </Fragment>
                  );
                })}
              </dl>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function Outcome({ detail, busy, onAction }: { detail: RunDetail; busy: boolean; onAction: (a: "merge" | "discard") => void }) {
  const { state, status, finishDone } = detail;
  const skipped = skippedFindings(state.rounds);

  if (status === "clean") {
    const isFolder = state.workspace.kind === "folder";
    return (
      <div className="outcome outcome-ok">
        <CircleCheck className="outcome-icon" />
        <div className="outcome-body">
          <strong>
            {state.endReason === "rest-skipped"
              ? "Every remaining finding was marked Skip"
              : "The reviewer reported no findings"}
          </strong>
          {state.resultNote && <p className="outcome-note">{state.resultNote}</p>}
          {skipped.length > 0 && (
            <details className="skipped">
              <summary>
                <ChevronRight className="disclosure" />
                {skipped.length} finding{skipped.length === 1 ? "" : "s"} marked Skip
              </summary>
              <ul>
                {skipped.map((s) => (
                  <li key={`${s.round}:${s.finding.id}`}>
                    <div className="finding-meta">
                      <span className={`sev sev-${s.finding.severity}`}>{SEVERITY_LABEL[s.finding.severity] ?? s.finding.severity}</span>
                      <code>
                        {s.finding.file}
                        {s.finding.line ? `:${s.finding.line}` : ""}
                      </code>
                    </div>
                    <div>{s.finding.issue}</div>
                    <div className="muted small">Why skipped: {s.reason}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        {isFolder && !finishDone && (
          <div className="banner-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => onAction("merge")}>
              Merge into project
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => window.confirm("Delete the branch and all of this run's work?") && onAction("discard")}
            >
              Discard branch
            </button>
          </div>
        )}
        {finishDone && (
          <span className="finish-done">
            <Check />
            {finishDone === "merged" ? "Merged" : "Discarded"}
          </span>
        )}
      </div>
    );
  }

  const label = status === "failed" ? "The run failed" : status === "interrupted" ? "The run was interrupted" : "The run was stopped";
  return (
    <div className={`outcome ${status === "failed" ? "outcome-error" : "outcome-neutral"}`}>
      {status === "failed" ? <CircleX className="outcome-icon" /> : <CircleStop className="outcome-icon" />}
      <div className="outcome-body">
        <strong>{label}</strong>
        {state.error && <p>{state.error}</p>}
        {state.resultNote && <p className="muted">{state.resultNote}</p>}
        <p className="muted">Resume carries on from the step it stopped at.</p>
      </div>
    </div>
  );
}
