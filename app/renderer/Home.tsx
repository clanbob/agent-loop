import { useEffect, useState } from "react";
import { ArrowUpRight, Plus, RefreshCw } from "lucide-react";
import type { ToolStatus } from "../shared/api.ts";
import { DEFAULT_CHOICES, PROVIDER_NAMES, ROLES } from "../../src/roles.ts";
import { api } from "./api.ts";

const ROLE_COPY = {
  judge: { name: "Judge", job: "Plans the work, then rules Fix or Skip on every finding" },
  builder: { name: "Builder", job: "Carries out the plan and every finding marked Fix" },
  reviewer: { name: "Reviewer", job: "Inspects the changes and reports findings" },
} as const;

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
      <h1>Judge, build, review</h1>
      <p className="lead">
        Choose a model to plan the task, one to build it, and one to review the changes. Rounds repeat until the
        reviewer finds nothing left worth fixing.
      </p>
      <button className="btn btn-primary btn-large" onClick={onNew}>
        <Plus />
        New run
      </button>

      <ol className="loop" aria-label="Roles in each round">
        {ROLES.map((role) => (
          <li key={role} className="loop-step">
            <span className="loop-name">
              <span className={`role-key role-${role}`} />
              {ROLE_COPY[role].name}
            </span>
            <span className="loop-job">{ROLE_COPY[role].job}</span>
            <span className="loop-default">{PROVIDER_NAMES[DEFAULT_CHOICES[role].provider]} by default</span>
          </li>
        ))}
      </ol>

      <section className="card">
        <div className="card-head">
          <h2>Tools</h2>
          <button className="btn btn-small btn-ghost" onClick={check} disabled={checking}>
            <RefreshCw className={checking ? "spin" : undefined} />
            {checking ? "Checking" : "Check again"}
          </button>
        </div>
        {!tools && <p className="muted">Checking installed tools</p>}
        {tools && (
          <ul className="tool-list">
            {tools.map((t) => {
              const installUrl = !t.ok ? INSTALL_URLS[t.name] : undefined;
              return (
                <li key={t.name}>
                  <span className={`dot ${t.ok ? "dot-clean" : "dot-failed"}`} />
                  <span className="tool-list-name">{t.name}</span>
                  <span className="tool-list-detail">{t.detail}</span>
                  {installUrl && (
                    <a className="btn btn-small tool-install" href={installUrl} target="_blank" rel="noopener noreferrer"
                      aria-label={`Install ${t.name}`}>
                      Install
                      <ArrowUpRight />
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
