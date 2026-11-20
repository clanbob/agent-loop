import { useCallback, useEffect, useState } from "react";
import type { RunListItem } from "../shared/api.ts";
import { api, isMock } from "./api.ts";
import { STATUS_LABEL, runDate } from "./format.ts";
import { Home } from "./Home.tsx";
import { NewRun } from "./NewRun.tsx";
import { RunView } from "./RunView.tsx";

type View = { kind: "home" } | { kind: "new" } | { kind: "run"; id: string };

export function App() {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [view, setView] = useState<View>({ kind: "home" });

  const refresh = useCallback(() => {
    api.listRuns().then(setRuns).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return api.onEvent((event) => {
      if (event.type === "runs") refresh();
    });
  }, [refresh]);

  const active = runs.filter((r) => r.live);
  const earlier = runs.filter((r) => !r.live);

  const select = (id: string) => setView({ kind: "run", id });

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ⟳
          </span>
          Agent Loop
          {isMock && <span className="tag tag-preview">preview</span>}
        </div>
        <button className="btn btn-primary btn-block" onClick={() => setView({ kind: "new" })}>
          + New run
        </button>
        <nav className="run-list">
          {active.length > 0 && <h3 className="list-heading">Active</h3>}
          {active.map((r) => (
            <RunItem key={r.id} run={r} selected={view.kind === "run" && view.id === r.id} onSelect={select} />
          ))}
          {earlier.length > 0 && <h3 className="list-heading">Earlier</h3>}
          {earlier.map((r) => (
            <RunItem key={r.id} run={r} selected={view.kind === "run" && view.id === r.id} onSelect={select} />
          ))}
          {runs.length === 0 && <p className="muted small pad">No runs yet.</p>}
        </nav>
        <button className="btn btn-ghost btn-block sidebar-foot" onClick={() => setView({ kind: "home" })}>
          Tool status
        </button>
      </aside>
      <main className="main">
        {view.kind === "home" && <Home onNew={() => setView({ kind: "new" })} />}
        {view.kind === "new" && <NewRun onStarted={select} onCancel={() => setView({ kind: "home" })} />}
        {view.kind === "run" && (
          <RunView key={view.id} id={view.id} onDeleted={() => setView({ kind: "home" })} />
        )}
      </main>
    </div>
  );
}

function RunItem({ run, selected, onSelect }: { run: RunListItem; selected: boolean; onSelect: (id: string) => void }) {
  const status = run.paused ? "paused" : run.status;
  const details = `${run.title}\n${run.kind === "roblox" ? "Roblox" : "Project"} · ${run.paused ? "Paused" : STATUS_LABEL[run.status]}${run.round > 0 ? ` · round ${run.round}` : ""} · ${runDate(run.id)}`;
  return (
    <button className={`run-item ${selected ? "selected" : ""}`} onClick={() => onSelect(run.id)} title={details}>
      <span className={`dot dot-${status}`} />
      <span className="run-item-title">{run.title}</span>
    </button>
  );
}
