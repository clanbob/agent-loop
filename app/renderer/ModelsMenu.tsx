import { useEffect, useState } from "react";
import type { AgentChoice, AgentChoices, AgentModels, ModelCatalog, Target } from "../shared/api.ts";
import { api } from "./api.ts";

const AGENTS = [
  ["judge", "Antigravity", "plans and judges"],
  ["builder", "Claude", "builds"],
  ["reviewer", "Codex", "reviews"],
] as const;

type AgentKey = (typeof AGENTS)[number][0];

export const EMPTY_CHOICES: AgentChoices = {
  judge: { model: null, effort: null },
  builder: { model: null, effort: null },
  reviewer: { model: null, effort: null },
};

function modelLabel(info: AgentModels | undefined, id: string | null): string {
  if (!id) return "default";
  return info?.models.find((m) => m.id === id)?.label ?? id;
}

function summary(catalog: ModelCatalog | null, choices: AgentChoices): string {
  return AGENTS.map(([key, name]) => {
    const info = catalog?.[key];
    const model = choices[key].model ?? info?.defaultModel ?? null;
    const effort = choices[key].effort ?? info?.defaultEffort ?? null;
    return `${name}: ${modelLabel(info, model)}${effort ? ` · ${effort}` : ""}`;
  }).join("  |  ");
}

export function ModelsMenu({
  target,
  choices,
  onChange,
}: {
  target: Target;
  choices: AgentChoices;
  onChange: (next: AgentChoices) => void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = (refresh = false) => {
    setLoading(true);
    api
      .listModels(refresh)
      .then(setCatalog)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => load(), []);

  const set = (key: AgentKey, patch: Partial<AgentChoice>) =>
    onChange({ ...choices, [key]: { ...choices[key], ...patch } });

  return (
    <div className={`models ${open ? "open" : ""}`}>
      <button className="models-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="models-title">Models</span>
        <span className="models-summary">{catalog ? summary(catalog, choices) : "Loading…"}</span>
        <span className="chevron" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="models-body">
          <p className="hint">
            Saved separately for {target === "roblox" ? "Roblox Studio" : "project"} runs. Each run keeps the models it
            started with, also when resumed.
          </p>
          <div className="models-grid">
            {AGENTS.map(([key, name, role]) => {
              const info = catalog?.[key];
              const choice = choices[key];
              return (
                <div key={key} className="models-row">
                  <div className="models-agent">
                    <span className={`agent-dot agent-${key === "judge" ? "judge" : key === "builder" ? "claude" : "codex"}`} />
                    <strong>{name}</strong>
                    <span className="muted small">{role}</span>
                  </div>
                  <label className="models-field">
                    <span className="sr-only">{name} model</span>
                    <select value={choice.model ?? ""} onChange={(e) => set(key, { model: e.target.value || null })}>
                      <option value="">Default{info?.defaultModel ? ` (${modelLabel(info, info.defaultModel)})` : ""}</option>
                      {info?.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                      {choice.model && info && !info.models.some((m) => m.id === choice.model) && (
                        <option value={choice.model}>{choice.model}</option>
                      )}
                    </select>
                  </label>
                  <label className="models-field effort">
                    <span className="sr-only">{name} effort</span>
                    <select value={choice.effort ?? ""} onChange={(e) => set(key, { effort: e.target.value || null })}>
                      <option value="">Effort: default{info?.defaultEffort ? ` (${info.defaultEffort})` : ""}</option>
                      {info?.efforts.map((effort) => (
                        <option key={effort} value={effort}>
                          Effort: {effort}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              );
            })}
          </div>
          <div className="models-foot">
            <button className="btn btn-small" onClick={() => onChange(EMPTY_CHOICES)}>
              Reset to defaults
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => load(true)} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh model lists"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
