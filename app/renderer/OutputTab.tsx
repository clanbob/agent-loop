import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { LogLine } from "../shared/api.ts";
import { AGENT_LABEL } from "./format.ts";
import { Segmented } from "./Segmented.tsx";

const FILTERS = [
  ["all", "All"],
  ["judge", <><span className="role-key role-judge" />Judge</>],
  ["builder", <><span className="role-key role-builder" />Builder</>],
  ["reviewer", <><span className="role-key role-reviewer" />Reviewer</>],
  ["loop", <><span className="role-key role-loop" />Loop</>],
] as const;

export function OutputTab({ logs, live }: { logs: LogLine[]; live: boolean }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () => filter === "all" ? logs : logs.filter((line) => line.agent === filter || (filter === "loop" && line.agent === "setup")),
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
            <ArrowDown />
            Jump to latest
          </button>
        )}
      </div>
      <div className="log" ref={box} onScroll={onScroll}>
        {shown.length === 0 && (
          <p className="log-empty">
            {live
              ? "Waiting for agent output."
              : "No output was kept for this run. Live output is only kept while the app is open."}
          </p>
        )}
        {shown.map((l, i) => {
          const role = l.agent === "setup" ? "loop" : l.agent;
          return (
            <div key={i} className="log-line">
              <span className="log-time">{new Date(l.at).toLocaleTimeString()}</span>
              <span className="log-agent">
                <span className={`role-key role-${role}`} />
                {AGENT_LABEL[l.agent] ?? l.agent}
              </span>
              <span className="log-text">{l.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
