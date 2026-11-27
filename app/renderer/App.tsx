import { useCallback, useEffect, useState } from "react";
import { Activity, Plus } from "lucide-react";
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
          <LoopMark />
          <span>Agent Loop</span>
          {isMock && <span className="brand-note">Preview</span>}
        </div>
        <button className={`nav-row nav-new ${view.kind === "new" ? "selected" : ""}`} onClick={() => setView({ kind: "new" })}>
          <span className="nav-icon">
            <Plus />
          </span>
          New run
        </button>
        <nav className="run-list" aria-label="Runs">
          {active.length > 0 && <h3 className="list-heading">Active</h3>}
          {active.map((r) => (
            <RunItem key={r.id} run={r} selected={view.kind === "run" && view.id === r.id} onSelect={select} />
          ))}
          {earlier.length > 0 && <h3 className="list-heading">Earlier</h3>}
          {earlier.map((r) => (
            <RunItem key={r.id} run={r} selected={view.kind === "run" && view.id === r.id} onSelect={select} />
          ))}
          {runs.length === 0 && <p className="list-empty">No runs yet</p>}
        </nav>
        <button className={`nav-row ${view.kind === "home" ? "selected" : ""}`} onClick={() => setView({ kind: "home" })}>
          <span className="nav-icon">
            <Activity />
          </span>
          Overview
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

function LoopMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.25"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

function RunItem({ run, selected, onSelect }: { run: RunListItem; selected: boolean; onSelect: (id: string) => void }) {
  const status = run.paused ? "paused" : run.status;
  const details = `${run.title}\n${run.kind === "roblox" ? "Roblox" : run.kind === "tools" ? "MCP tools" : "Project"} · ${run.paused ? "Paused" : STATUS_LABEL[run.status]}${run.round > 0 ? ` · round ${run.round}` : ""} · ${runDate(run.id)}`;
  return (
    <button className={`nav-row ${selected ? "selected" : ""}`} onClick={() => onSelect(run.id)} title={details}>
      <span className="nav-icon">
        <span className={`dot dot-${status}`} />
      </span>
      <span className="nav-label">{run.title}</span>
    </button>
  );
}
