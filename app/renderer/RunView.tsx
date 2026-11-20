import { Fragment, useEffect, useState } from "react";
import type { LogLine, RunDetail } from "../shared/api.ts";
import { DEFAULT_CHOICES, PROVIDER_NAMES } from "../../src/roles.ts";
import { api, errorText } from "./api.ts";
import { STATUS_LABEL, basename, duration, phaseLabel, runDate, runTitle, timedSteps } from "./format.ts";
import { RoundsTab } from "./RoundsTab.tsx";
import { OutputTab } from "./OutputTab.tsx";
import { ChangesTab } from "./ChangesTab.tsx";
import { skippedFindings } from "./findings.ts";
import { Segmented } from "./Segmented.tsx";

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

  if (detail === undefined) return <div className="page muted">Loading…</div>;
  if (detail === null) return <div className="page muted">This run no longer exists.</div>;

  const { state, status, live, pending } = detail;
  const steps = timedSteps(state.timeline ?? [], state.finishedAt);
  const current = live ? steps[steps.length - 1] : null;
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
            <span className={`status status-${displayStatus}`}>
              <span className={`dot dot-${displayStatus}`} />
              {pending ? "Paused" : STATUS_LABEL[status]}
            </span>
            <span>{target}</span>
            {state.startMode && (
              <span className="start-mode" title={state.startReason ?? undefined}>
                Started with {state.startMode}
              </span>
            )}
            <span>Round {Math.max(state.cursor.round, 1)}</span>
            <span>{duration(ended - started)}</span>
            <span className="muted">{runDate(state.id)}</span>
          </div>
        </div>
        <div className="run-head-actions">
          {live && (
            <button className="btn btn-danger" disabled={busy} onClick={() => act(() => api.stopRun(id))}>
              Stop
            </button>
          )}
          {!live && status !== "clean" && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.resumeRun(id))}>
              Resume
            </button>
          )}
          {!live && (
            <button className="btn btn-ghost" disabled={busy} onClick={remove}>
              Delete
            </button>
          )}
        </div>
      </header>

      {current && !pending && (
        <div className="now">
          <span className="spinner" aria-hidden />
          <strong>{phaseLabel(current.phase, current.round)}</strong>
          <span className="muted">for {duration(now - current.start)}</span>
        </div>
      )}

      {pending?.kind === "review" && (
        <div className="banner banner-warn">
          <strong>Round {pending.round} is waiting for your review.</strong>
          {tab !== "rounds" && <button className="btn" onClick={() => setTab("rounds")}>Review findings</button>}
        </div>
      )}

      {pending?.kind === "limit" && (
        <div className="banner banner-warn">
          <div>
            <strong>{pending.pause.agent} is out of usage.</strong>
            {pending.pause.message && <div className="muted">{pending.pause.message}</div>}
            <div>
              {pending.pause.resetAt
                ? `Its limit resets around ${new Date(pending.pause.resetAt).toLocaleString()}.`
                : "It did not say when its limit resets."}{" "}
              The run waits until you resume it; you can also close the app and resume later.
            </div>
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
          <div>
            <strong>{pending.pause.reason}</strong>
            {pending.pause.details.length > 0 && (
              <ul className="banner-list">
                {pending.pause.details.slice(0, 12).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
                {pending.pause.details.length > 12 && <li className="muted">…and {pending.pause.details.length - 12} more</li>}
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

      {notice && <div className={`banner ${notice.ok ? "banner-ok" : "banner-error"}`}>{notice.text}</div>}

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
            <h3>Task</h3>
            <pre className="prose-pre">{state.task}</pre>
            {state.startMode && (
              <>
                <h3>Starting point</h3>
                <p className="prose-pre">
                  {state.startMode === "review"
                    ? "The reviewer inspected the existing code first."
                    : "The builder made changes before the first review."}
                  {state.startReason && <span className="muted"> {state.startReason}</span>}
                </p>
              </>
            )}
            {state.instructions && (
              <>
                <h3>Latest instructions</h3>
                <pre className="prose-pre">{state.instructions}</pre>
              </>
            )}
            <h3>Workspace</h3>
            {state.workspace.kind === "folder" ? (
              <dl className="kv">
                <dt>Project</dt>
                <dd>{state.workspace.project}</dd>
                <dt>Branch</dt>
                <dd>{state.workspace.branch}</dd>
                <dt>Scope</dt>
                <dd>{state.workspace.scope.join(", ") || "Anywhere"}</dd>
                <dt>Tests</dt>
                <dd>{state.workspace.testCommand ?? "None"}</dd>
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
                <dd>{state.workspace.scope.join(", ")}</dd>
              </dl>
            )}
            {state.workspace.environment && (
              <>
                <h3>Environment</h3>
                <dl className="kv">
                  <dt>Name</dt>
                  <dd>{state.workspace.environment.name}</dd>
                  <dt>MCP tools</dt>
                  <dd>{envTools.join(", ") || "None"}</dd>
                </dl>
              </>
            )}
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
                    <dt>{name}</dt>
                    <dd>
                      {PROVIDER_NAMES[choice?.provider ?? DEFAULT_CHOICES[key].provider]} · {choice?.model ?? "default model"}
                      {choice?.effort ? ` · effort ${choice.effort}` : ""}
                    </dd>
                  </Fragment>
                );
              })}
            </dl>
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
        <div className="outcome-head">
          <div>
            <strong>
              {state.endReason === "rest-skipped"
                ? "Every remaining finding was marked Skip."
                : "The reviewer reported no findings."}
            </strong>
            {state.resultNote && <pre className="prose-pre small">{state.resultNote}</pre>}
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
          {finishDone && <span className="tag">{finishDone === "merged" ? "Merged" : "Discarded"}</span>}
        </div>
        {skipped.length > 0 && (
          <details className="skipped">
            <summary>
              {skipped.length} finding{skipped.length === 1 ? "" : "s"} marked Skip
            </summary>
            <ul>
              {skipped.map((s) => (
                <li key={`${s.round}:${s.finding.id}`}>
                  <span className={`sev sev-${s.finding.severity}`}>{s.finding.severity}</span>{" "}
                  <code>
                    {s.finding.file}
                    {s.finding.line ? `:${s.finding.line}` : ""}
                  </code>{" "}
                  {s.finding.issue}
                  <div className="muted small">Why skipped: {s.reason}</div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }

  const label = status === "failed" ? "The run failed." : status === "interrupted" ? "The run was interrupted." : "The run was stopped.";
  return (
    <div className={`outcome ${status === "failed" ? "outcome-error" : "outcome-neutral"}`}>
      <strong>{label}</strong>
      {state.error && <div>{state.error}</div>}
      {state.resultNote && <div className="muted small">{state.resultNote}</div>}
      <div className="muted small">Resume carries on from the step it stopped at.</div>
    </div>
  );
}
