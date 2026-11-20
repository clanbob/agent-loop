import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { AgentChoices, AppInfo, Environment, Setup } from "../shared/api.ts";
import { api, errorText } from "./api.ts";
import { basename } from "./format.ts";
import { DEFAULT_CHOICES } from "../../src/roles.ts";
import { ModelsMenu } from "./ModelsMenu.tsx";
import { EnvironmentDialog } from "./EnvironmentDialog.tsx";

const PREFS_KEY = "agentloop.newrun.v2";

interface Prefs {
  environmentId: string;
  projects: Record<string, string>;
  tests: Record<string, string>;
  scopes: Record<string, string[]>;
  agents: Record<string, AgentChoices>;
}

const EMPTY_PREFS: Prefs = { environmentId: "project-folder", projects: {}, tests: {}, scopes: {}, agents: {} };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...EMPTY_PREFS, ...JSON.parse(raw) };
  } catch {}
  return EMPTY_PREFS;
}

function updatePrefs(patch: (prefs: Prefs) => Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(patch(loadPrefs())));
  } catch {}
}

type Mode = "folder" | "roblox" | "tools" | "none";

export function NewRun({ onStarted, onCancel }: { onStarted: (id: string) => void; onCancel: () => void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [envId, setEnvId] = useState(loadPrefs().environmentId);
  const [project, setProject] = useState("");
  const [task, setTask] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [scopeDraft, setScopeDraft] = useState("");
  const [test, setTest] = useState("");
  const [manualReview, setManualReview] = useState(false);
  const [agents, setAgents] = useState<AgentChoices>(DEFAULT_CHOICES);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [dialog, setDialog] = useState<{ editing: Environment | null } | null>(null);

  const loadSetup = useCallback(() => api.getSetup().then(setSetup).catch(() => {}), []);

  useEffect(() => {
    loadSetup();
    api.info().then(setInfo).catch(() => {});
  }, [loadSetup]);

  const env = setup?.environments.find((e) => e.id === envId) ?? setup?.environments[0] ?? null;
  const envTools = env && setup ? setup.tools.filter((t) => env.toolIds.includes(t.id)) : [];
  const hasRoblox = envTools.some((t) => t.builtIn === "roblox-studio");
  const mode: Mode = project.trim() ? "folder" : hasRoblox ? "roblox" : envTools.length > 0 ? "tools" : "none";

  const selectEnv = useCallback((next: Environment) => {
    const prefs = loadPrefs();
    setEnvId(next.id);
    setProject(prefs.projects[next.id] ?? next.projectPath);
    setTest(prefs.tests[next.id] ?? "");
    setScope(prefs.scopes[next.id] ?? []);
    setAgents(prefs.agents[next.id] ?? DEFAULT_CHOICES);
    setScopeDraft("");
    setError("");
    updatePrefs((p) => ({ ...p, environmentId: next.id }));
  }, []);

  useEffect(() => {
    if (env && env.id !== envId) selectEnv(env);
  }, [env, envId, selectEnv]);

  const initialized = Boolean(setup);
  useEffect(() => {
    if (initialized && env) selectEnv(env);
  }, [initialized]);

  const changeAgents = useCallback(
    (next: AgentChoices) => {
      setAgents(next);
      updatePrefs((p) => ({ ...p, agents: { ...p.agents, [envId]: next } }));
    },
    [envId],
  );

  const addScope = () => {
    const value = scopeDraft.trim();
    if (value && !scope.includes(value)) setScope([...scope, value]);
    setScopeDraft("");
  };

  const onScopeKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addScope();
    }
  };

  const browse = async () => {
    const folder = await api.pickFolder();
    if (folder) setProject(folder);
  };

  const pendingScope = scopeDraft.trim();
  const finalScope = pendingScope && !scope.includes(pendingScope) ? [...scope, pendingScope] : scope;
  const missing = !task.trim()
    ? "Describe the task."
    : mode === "none"
      ? "Choose a project folder, or edit this environment to add MCP tools."
      : mode === "roblox" && finalScope.length === 0
        ? "Add at least one Studio location the run may change."
        : "";

  const start = async () => {
    if (!env) return;
    if (missing) return setError(missing);
    setStarting(true);
    setError("");
    try {
      const { id } = await api.startRun({ environmentId: env.id, project, task, scope: finalScope, test: mode === "folder" ? test : "", guides: [], agents, manualReview });
      updatePrefs((p) => ({
        ...p,
        environmentId: env.id,
        projects: { ...p.projects, [env.id]: project },
        tests: { ...p.tests, [env.id]: test },
        scopes: { ...p.scopes, [env.id]: finalScope },
      }));
      onStarted(id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const guides = info?.guides ?? [];

  const projectHint =
    mode === "folder"
      ? `Must be a git project. The run works on a new branch in a separate copy, so your own files are not touched.${envTools.length > 0 ? ` The builder also gets ${envTools.length === 1 ? "the" : "these"} MCP tool${envTools.length === 1 ? "" : "s"}: ${envTools.map((t) => t.name).join(", ")}.` : ""}`
      : mode === "roblox"
        ? "No project: edits the place open in Roblox Studio, live. The reviewer inspects a copy of the scripts. Save a backup of the place first (File → Save to File)."
        : mode === "tools"
          ? `No project: the builder works only through ${envTools.map((t) => t.name).join(", ")}, and the reviewer inspects by looking through the same tools, read only.`
          : envTools.length === 0 && env?.builtIn === "project"
            ? "Choose a git project. The run works on a new branch in a separate copy, so your own files are not touched."
            : "This environment has no MCP tools, so it needs a project folder.";

  return (
    <div className="page narrow">
      <h1>New run</h1>

      <div className="field">
        <span className="field-label">Environment</span>
        <div className="env-grid">
          {setup?.environments.map((e) => {
            const tools = setup.tools.filter((t) => e.toolIds.includes(t.id));
            return (
              <div key={e.id} className={`env-card ${e.id === env?.id ? "on" : ""}`}>
                <button className="env-main" onClick={() => selectEnv(e)} aria-pressed={e.id === env?.id}>
                  <span className="env-name">{e.name}</span>
                  <span className="env-tools">
                    {tools.length > 0 ? tools.map((t) => <span key={t.id} className="mini-chip">{t.name}</span>) : <span className="muted small">No MCP tools</span>}
                  </span>
                  <span className="env-path muted small">{e.projectPath ? basename(e.projectPath) : "No default project"}</span>
                </button>
                <button className="env-edit" onClick={() => setDialog({ editing: e })} aria-label={`Edit ${e.name}`}>
                  Edit
                </button>
              </div>
            );
          })}
          <button className="env-card env-new" onClick={() => setDialog({ editing: null })}>
            <span className="env-plus" aria-hidden>
              +
            </span>
            New environment
          </button>
        </div>
      </div>

      <ModelsMenu scopeLabel={env ? `the ${env.name} environment` : "this environment"} choices={agents} onChange={changeAgents} />

      <label className="field review-option">
        <span><input type="checkbox" checked={manualReview} onChange={(e) => setManualReview(e.target.checked)} /> Manual review</span>
        <span className="hint">Choose Fix or Skip for each finding, then send the fixes to the builder.</span>
      </label>

      <label className="field">
        <span className="field-label">
          Project folder <span className="muted">(optional)</span>
        </span>
        <div className="row">
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="C:\path\to\your\git\project" spellCheck={false} />
          <button className="btn" onClick={browse}>
            Browse…
          </button>
          {project && (
            <button className="btn btn-ghost" onClick={() => setProject("")}>
              Clear
            </button>
          )}
        </div>
        <span className="hint">{projectHint}</span>
      </label>

      <label className="field">
        <span className="field-label">Task</span>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={8}
          placeholder="Describe what to build or review. Start with “Review:” to go straight to the reviewer."
        />
      </label>

      <div className="field">
        <span className="field-label">
          {mode === "roblox" ? "Studio locations the run may change" : mode === "tools" ? "Focus" : "Folders the run may change"}
          {mode !== "roblox" && <span className="muted"> (optional{mode === "folder" ? "; empty means anywhere" : ""})</span>}
        </span>
        {scope.length > 0 && (
          <ul className="chips">
            {scope.map((s) => (
              <li key={s} className="chip">
                {s}
                <button aria-label={`Remove ${s}`} onClick={() => setScope(scope.filter((x) => x !== s))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <input
            value={scopeDraft}
            onChange={(e) => setScopeDraft(e.target.value)}
            onKeyDown={onScopeKey}
            placeholder={mode === "roblox" ? "ServerScriptService/Combat" : mode === "tools" ? "for example: the orders table" : "src/cart"}
            spellCheck={false}
          />
          <button className="btn" onClick={addScope} disabled={!scopeDraft.trim()}>
            Add
          </button>
        </div>
      </div>

      {mode === "folder" && (
        <label className="field">
          <span className="field-label">
            Test command <span className="muted">(optional)</span>
          </span>
          <input value={test} onChange={(e) => setTest(e.target.value)} placeholder="npm test" spellCheck={false} />
          <span className="hint">Runs after every build. Failing tests count as findings.</span>
        </label>
      )}

      <p className="hint follows">
        Also follows the project's own CLAUDE.md / AGENTS.md
        {guides.length > 0 && (
          <>
            {" "}and your Claude guides:{" "}
            {guides.map((g, i) => (
              <span key={g} title={g}>
                {i > 0 ? ", " : ""}
                {basename(g)}
              </span>
            ))}
          </>
        )}
        .
      </p>

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button className="btn btn-primary" onClick={start} disabled={starting || !env}>
          {starting ? "Starting…" : "Start run"}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {dialog && setup && (
        <EnvironmentDialog
          editing={dialog.editing}
          setup={setup}
          onClose={() => setDialog(null)}
          onSetupChanged={loadSetup}
          onSaved={async (saved) => {
            setDialog(null);
            await loadSetup();
            updatePrefs((p) => {
              const projects = { ...p.projects };
              delete projects[saved.id];
              return { ...p, projects };
            });
            selectEnv(saved);
          }}
          onDeleted={async (id) => {
            setDialog(null);
            await loadSetup();
            if (id === envId) setEnvId("project-folder");
          }}
        />
      )}
    </div>
  );
}
