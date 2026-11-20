import { useEffect, useMemo, useState } from "react";
import type { RunState } from "../shared/api.ts";
import { api } from "./api.ts";

interface FileDiff {
  name: string;
  lines: string[];
  added: number;
  removed: number;
}

function splitDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/ b\/(.+)$/);
      current = { name: match?.[1] ?? line, lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
    current.lines.push(line);
  }
  return files;
}

export function ChangesTab({ id, state }: { id: string; state: RunState }) {
  const rounds = state.rounds.map((r) => r.round);
  const latest = rounds.length > 0 ? Math.max(...rounds) : 0;
  const [round, setRound] = useState(latest);
  const [which, setWhich] = useState<"total" | "round">("total");
  const [text, setText] = useState<string | null>(null);

  useEffect(() => setRound(latest), [latest]);

  useEffect(() => {
    if (!round) return;
    setText(null);
    api.readDiff(id, round, which).then(setText);
  }, [id, round, which]);

  const files = useMemo(() => (text ? splitDiff(text) : []), [text]);

  if (rounds.length === 0) return <p className="muted">No changes have been reviewed yet.</p>;

  return (
    <div className="changes">
      <div className="output-bar">
        <label className="inline">
          Round{" "}
          <select value={round} onChange={(e) => setRound(Number(e.target.value))}>
            {rounds.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented small">
          <button className={which === "total" ? "on" : ""} onClick={() => setWhich("total")}>
            All changes so far
          </button>
          <button className={which === "round" ? "on" : ""} onClick={() => setWhich("round")}>
            This round only
          </button>
        </div>
      </div>
      {text === null && <p className="muted">Loading…</p>}
      {text !== null && files.length === 0 && <p className="muted">No changes in this view.</p>}
      {files.map((f) => (
        <details key={f.name} className="diff-file" open={files.length <= 6}>
          <summary>
            <code>{f.name}</code>
            <span className="ok-text">+{f.added}</span>
            <span className="error-text">−{f.removed}</span>
          </summary>
          <pre className="diff">
            {f.lines.map((line, i) => (
              <div
                key={i}
                className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : ""}
              >
                {line || " "}
              </div>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}
