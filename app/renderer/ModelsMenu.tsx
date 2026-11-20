import { useEffect, useState } from "react";
import type { AgentChoice, AgentChoices, AgentModels, ModelCatalog } from "../shared/api.ts";
import { api } from "./api.ts";

const AGENTS = [
  ["judge", "Antigravity", "plans and judges", "judge"],
  ["builder", "Claude", "builds", "claude"],
  ["reviewer", "Codex", "reviews", "codex"],
] as const;

type AgentKey = (typeof AGENTS)[number][0];

const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export const DEFAULT_CHOICES: AgentChoices = {
  judge: { model: "gemini-4-neon", effort: "medium" },
  builder: { model: "opus", effort: "medium" },
  reviewer: { model: "gpt-6.2-astra", effort: "medium" },
};

function effortLabel(effort: string | null): string {
  return effort ? (EFFORT_LABEL[effort] ?? effort) : "";
}

function pickEffort(efforts: string[], wanted: string | null, fallback: string): string | null {
  if (efforts.length === 0) return null;
  if (wanted && efforts.includes(wanted)) return wanted;
  if (efforts.includes(fallback)) return fallback;
  if (efforts.includes("medium")) return "medium";
  return efforts[0];
}

function normalizeOne(info: AgentModels, choice: AgentChoice | undefined): AgentChoice {
  const model = info.models.find((m) => m.id === choice?.model) ?? info.models.find((m) => m.id === info.defaultModel) ?? info.models[0];
  if (!model) return { model: info.defaultModel, effort: info.defaultEffort };
  return { model: model.id, effort: pickEffort(model.efforts, choice?.effort ?? null, info.defaultEffort) };
}

export function normalizeChoices(catalog: ModelCatalog, choices: AgentChoices | undefined): AgentChoices {
  return {
    judge: normalizeOne(catalog.judge, choices?.judge),
    builder: normalizeOne(catalog.builder, choices?.builder),
    reviewer: normalizeOne(catalog.reviewer, choices?.reviewer),
  };
}

function sameChoices(a: AgentChoices, b: AgentChoices): boolean {
  return AGENTS.every(([key]) => a[key].model === b[key].model && a[key].effort === b[key].effort);
}

function modelLabel(info: AgentModels | undefined, id: string | null): string {
  return info?.models.find((m) => m.id === id)?.label ?? id ?? "";
}

export function ModelsMenu({
  scopeLabel,
  choices,
  onChange,
}: {
  scopeLabel: string;
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

  useEffect(() => {
    if (!catalog) return;
    const normalized = normalizeChoices(catalog, choices);
    if (!sameChoices(normalized, choices)) onChange(normalized);
  }, [catalog, choices, onChange]);

  const setModel = (key: AgentKey, modelId: string) => {
    const info = catalog?.[key];
    const model = info?.models.find((m) => m.id === modelId);
    const effort = model && info ? pickEffort(model.efforts, choices[key].effort, info.defaultEffort) : choices[key].effort;
    onChange({ ...choices, [key]: { model: modelId, effort } });
  };

  const setEffort = (key: AgentKey, effort: string) => onChange({ ...choices, [key]: { ...choices[key], effort } });

  const summary = AGENTS.map(([key, name]) => {
    const choice = choices[key];
    const effort = effortLabel(choice.effort);
    return `${name}: ${modelLabel(catalog?.[key], choice.model)}${effort ? ` · ${effort}` : ""}`;
  }).join("   |   ");

  return (
    <div className={`models ${open ? "open" : ""}`}>
      <button className="models-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="models-title">Models</span>
        <span className="models-summary">{catalog ? summary : "Loading models…"}</span>
        <span className="chevron" aria-hidden>
          ▾
        </span>
      </button>
      <div className="models-collapse">
        <div className="models-body">
          <div className="models-grid">
            <span />
            <span className="models-head">Model</span>
            <span className="models-head">Effort</span>
            {AGENTS.map(([key, name, role, color]) => {
              const info = catalog?.[key];
              const choice = choices[key];
              const efforts = info?.models.find((m) => m.id === choice.model)?.efforts ?? [];
              return (
                <div key={key} className="models-row">
                  <div className="models-agent">
                    <span className={`agent-dot agent-${color}`} />
                    <strong>{name}</strong>
                    <span className="muted small">{role}</span>
                  </div>
                  <select
                    aria-label={`${name} model`}
                    value={choice.model ?? ""}
                    onChange={(e) => setModel(key, e.target.value)}
                    disabled={!info}
                  >
                    {info?.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`${name} effort`}
                    value={choice.effort ?? ""}
                    onChange={(e) => setEffort(key, e.target.value)}
                    disabled={efforts.length === 0}
                  >
                    {efforts.length === 0 && <option value="">Not adjustable</option>}
                    {efforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {effortLabel(effort)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          <div className="models-foot">
            <span className="hint">
              Saved for {scopeLabel}. A run keeps its models when resumed.
            </span>
            <span className="models-actions">
              <button className="btn btn-small" onClick={() => catalog && onChange(normalizeChoices(catalog, DEFAULT_CHOICES))}>
                Reset
              </button>
              <button className="btn btn-small btn-ghost" onClick={() => load(true)} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh lists"}
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
