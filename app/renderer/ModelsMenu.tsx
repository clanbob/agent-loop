import { useEffect, useState } from "react";
import { DEFAULT_CHOICES, PROVIDERS, PROVIDER_NAMES, ROLES, type AgentChoices, type Provider, type Role } from "../../src/roles.ts";
import type { ModelCatalog } from "../shared/api.ts";
import { api } from "./api.ts";

const ROLE_LABEL = { judge: "Judge", builder: "Builder", reviewer: "Reviewer" };
const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };

export function ModelsMenu({ scopeLabel, choices, onChange }: {
  scopeLabel: string;
  choices: AgentChoices;
  onChange: (next: AgentChoices) => void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = (refresh = false) => {
    setLoading(true);
    setError("");
    api.listModels(refresh).then(setCatalog).catch(() => setError("Could not load the model lists.")).finally(() => setLoading(false));
  };
  useEffect(() => load(), []);

  function selectModel(role: Role, provider: Provider, model: string) {
    const info = catalog?.[provider];
    const known = info?.models.find((m) => m.id === model);
    const preferred = choices[role].effort;
    const fallback = info?.defaultEffort ?? "medium";
    const effort = known?.efforts.includes(preferred ?? "") ? preferred
      : known?.efforts.includes(fallback) ? fallback : known?.efforts[0] ?? null;
    onChange({ ...choices, [role]: { provider, model, effort } });
  }

  const summary = ROLES.map((role) => {
    const choice = choices[role];
    const provider = choice.provider ?? DEFAULT_CHOICES[role].provider;
    const label = catalog?.[provider].models.find((m) => m.id === choice.model)?.label ?? choice.model;
    return `${ROLE_LABEL[role]}: ${label || "Provider default"}`;
  }).join("   |   ");

  return (
    <div className={`models ${open ? "open" : ""}`}>
      <button className="models-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="models-title">Models</span>
        <span className="models-summary">{summary}</span>
        <span className="chevron" aria-hidden>▾</span>
      </button>
      <div className="models-collapse" inert={!open}>
        <div className="models-body">
          <div className="models-grid">
            <span />
            <span className="models-head">Provider</span>
            <span className="models-head">Model</span>
            <span className="models-head">Effort</span>
            {ROLES.map((role) => {
              const name = ROLE_LABEL[role];
              const choice = choices[role];
              const provider = choice.provider ?? DEFAULT_CHOICES[role].provider;
              const info = catalog?.[provider];
              const efforts = info?.models.find((m) => m.id === choice.model)?.efforts ?? [];
              return (
                <div key={role} className="models-row">
                  <strong>{name}</strong>
                  <select aria-label={`${name} provider`} value={provider} onChange={(e) => {
                    const next = e.target.value as Provider;
                    selectModel(role, next, catalog?.[next].defaultModel ?? "");
                  }}>
                    {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_NAMES[p]}</option>)}
                  </select>
                  <div>
                    <input aria-label={`${name} model`} list={`${role}-models`} value={choice.model ?? ""}
                      placeholder={info?.defaultModel ?? "Model ID"} spellCheck={false}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => selectModel(role, provider, e.target.value)} />
                    <datalist id={`${role}-models`}>
                      {info?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </datalist>
                  </div>
                  <select aria-label={`${name} effort`} value={choice.effort ?? ""} disabled={!efforts.length}
                    onChange={(e) => onChange({ ...choices, [role]: { ...choice, provider, effort: e.target.value || null } })}>
                    <option value="">Provider default</option>
                    {efforts.map((effort) => <option key={effort} value={effort}>{EFFORT_LABEL[effort] ?? effort}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
          <div className="models-foot">
            <span className="hint">{error || `Saved for ${scopeLabel}. You can also enter a model ID.`}</span>
            <span className="models-actions">
              <button className="btn btn-small" onClick={() => onChange(DEFAULT_CHOICES)}>Reset</button>
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
