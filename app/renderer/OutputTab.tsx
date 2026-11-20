import { useEffect, useMemo, useRef, useState } from "react";
import type { LogLine } from "../shared/api.ts";
import { AGENT_LABEL } from "./format.ts";
import { Segmented } from "./Segmented.tsx";

const FILTERS = [
  ["all", "All"],
  ["judge", "Antigravity"],
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["loop", "Loop"],
] as const;

export function OutputTab({ logs, live }: { logs: LogLine[]; live: boolean }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () => (filter === "all" ? logs : logs.filter((l) => (filter === "loop" ? l.agent === "loop" || l.agent === "setup" : l.agent === filter))),
    [logs, filter],
  );

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <div className="output">
      <div className="output-bar">
        <Segmented small label="Show output from" options={FILTERS} value={filter} onChange={setFilter} />
        {!follow && (
          <button className="btn btn-small" onClick={() => setFollow(true)}>
            Jump to latest
          </button>
        )}
      </div>
      <div className="log" ref={box} onScroll={onScroll}>
        {shown.length === 0 && (
          <p className="muted">
            {live
              ? "Nothing yet. Claude shows each action as it works; Codex and Antigravity show their output when they report."
              : "No output was kept for this run. Live output is only kept while the app is open."}
          </p>
        )}
        {shown.map((l, i) => (
          <div key={i} className={`log-line agent-${l.agent}`}>
            <span className="log-time">{new Date(l.at).toLocaleTimeString()}</span>
            <span className="log-agent">{AGENT_LABEL[l.agent] ?? l.agent}</span>
            <span className="log-text">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
