import { useEffect, useState } from "react";
import type { ToolStatus } from "../shared/api.ts";
import { api } from "./api.ts";

const INSTALL_URLS: Record<string, string> = {
  Antigravity: "https://antigravity.google/download",
  Claude: "https://code.claude.com/docs/en/quickstart",
  Codex: "https://developers.openai.com/codex/cli",
};

export function Home({ onNew }: { onNew: () => void }) {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [checking, setChecking] = useState(false);

  const check = () => {
    setChecking(true);
    api
      .checkTools()
      .then(setTools)
      .finally(() => setChecking(false));
  };

  useEffect(check, []);

  return (
    <div className="page narrow">
      <h1>Agent Loop</h1>
      <p className="lead">
        Choose a model to plan the task, one to build it, and one to review the changes.
      </p>
      <button className="btn btn-primary" onClick={onNew}>
        + New run
      </button>

      <section className="card">
        <div className="card-head">
          <h2>Tools</h2>
          <button className="btn btn-small" onClick={check} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>
        {!tools && <p className="muted">Checking…</p>}
        {tools && (
          <ul className="tool-list">
            {tools.map((t) => {
              const installUrl = !t.ok ? INSTALL_URLS[t.name] : undefined;
              return (
                <li key={t.name}>
                  <span className={`dot ${t.ok ? "dot-clean" : "dot-failed"}`} />
                  <strong>{t.name}</strong>
                  <span className="muted tool-detail">{t.detail}</span>
                  {installUrl && (
                    <a
                      className="tool-install"
                      href={installUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Install ${t.name}`}
                    >
                      Install
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
