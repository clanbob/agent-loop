import { useEffect, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { DEFAULT_CHOICES, PROVIDERS, PROVIDER_NAMES, ROLES, type AgentChoices, type Provider, type Role } from "../../src/roles.ts";
import type { AgentModels, ModelCatalog } from "../shared/api.ts";
import { api } from "./api.ts";

const ROLE_LABEL = { judge: "Judge", builder: "Builder", reviewer: "Reviewer" };
const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };

const PROVIDER_LABEL = { ...PROVIDER_NAMES, antigravity: "Gemini (Antigravity)" };

function ModelPicker({ name, info, model, onChange }: {
  name: string;
  info?: AgentModels;
  model: string | null;
  onChange: (model: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const selected = model || info?.defaultModel || "";
  const options = info?.models ?? [];
  return (
    <div className="model-picker">
      <select aria-label={`${name} model`} disabled={!info} value={editing ? "" : selected}
        onChange={(e) => {
          setEditing(!e.target.value);
          if (e.target.value) onChange(e.target.value);
        }}>
        {selected && !options.some((option) => option.id === selected) && <option value={selected}>{selected}</option>}
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        <option value="">{info ? "Enter a model ID…" : "Loading models…"}</option>
      </select>
      {editing && (
        <input aria-label={`${name} custom model ID`} value={model ?? ""} placeholder="Model ID" autoFocus spellCheck={false}
          onFocus={(e) => e.currentTarget.select()} onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            onChange(model?.trim() || info?.defaultModel || "");
            setEditing(false);
          }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      )}
    </div>
  );
}

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
    return { role, label: label || "Provider default" };
  });

  const shown = PROVIDERS.filter((p) => ROLES.some((role) => (choices[role].provider ?? DEFAULT_CHOICES[role].provider) === p));
  const suggestions = shown.filter((p) => catalog?.[p].source === "suggestions").map((p) => PROVIDER_LABEL[p]);
  const fromCache = shown.filter((p) => catalog?.[p].source === "cache").map((p) => PROVIDER_LABEL[p]);

  return (
    <div className={`models ${open ? "open" : ""}`}>
      <button className="models-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="models-title">Models</span>
        <span className="models-summary">
          {summary.map(({ role, label }) => (
            <span key={role} className="models-pick">
              <span className={`role-key role-${role}`} />
              <span className="muted">{ROLE_LABEL[role]}</span>
              {label}
            </span>
          ))}
        </span>
        <ChevronDown className="chevron" />
      </button>
      {open && (
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
                  <span className="models-role">
                    <span className={`role-key role-${role}`} />
                    {name}
                  </span>
                  <select aria-label={`${name} provider`} value={provider} disabled={!catalog} onChange={(e) => {
                    const next = e.target.value as Provider;
                    selectModel(role, next, catalog?.[next].defaultModel ?? "");
                  }}>
                    {PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
                  </select>
                  <ModelPicker key={`${scopeLabel}:${provider}`} name={name} info={info} model={choice.model}
                    onChange={(model) => selectModel(role, provider, model)} />
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
            <span className="hint" aria-live="polite">
              {error || (catalog ? `Saved for ${scopeLabel}.` : "Loading model lists…")}
              {suggestions.length > 0 && ` Showing built-in suggestions for ${suggestions.join(", ")}. Check CLI sign-in and refresh for the current list.`}
              {fromCache.length > 0 && ` Showing the last available list for ${fromCache.join(", ")}.`}
            </span>
            <span className="models-actions">
              <button className="btn btn-small" onClick={() => onChange(DEFAULT_CHOICES)}>Reset</button>
              <button className="btn btn-small btn-ghost" onClick={() => load(true)} disabled={loading}>
                <RefreshCw className={loading ? "spin" : undefined} />
                {loading ? "Refreshing" : "Refresh lists"}
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
