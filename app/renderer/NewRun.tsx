import { useEffect, useState, type KeyboardEvent } from "react";
import type { AgentChoices, AppInfo, Target } from "../shared/api.ts";
import { api, errorText } from "./api.ts";
import { basename } from "./format.ts";
import { EMPTY_CHOICES, ModelsMenu } from "./ModelsMenu.tsx";

const PREFS_KEY = "agentloop.newrun";

interface Prefs {
  target: Target;
  project: string;
  test: string;
  robloxScope: string[];
  agents: Record<Target, AgentChoices>;
}

const DEFAULT_PREFS: Prefs = {
  target: "folder",
  project: "",
  test: "",
  robloxScope: [],
  agents: { folder: EMPTY_CHOICES, roblox: EMPTY_CHOICES },
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { ...DEFAULT_PREFS, ...saved, agents: { ...DEFAULT_PREFS.agents, ...saved.agents } };
    }
  } catch {}
  return DEFAULT_PREFS;
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

export function NewRun({ onStarted, onCancel }: { onStarted: (id: string) => void; onCancel: () => void }) {
  const initial = loadPrefs();
  const [target, setTarget] = useState<Target>(initial.target);
  const [project, setProject] = useState(initial.project);
  const [task, setTask] = useState("");
  const [scope, setScope] = useState<string[]>(initial.target === "roblox" ? initial.robloxScope : []);
  const [scopeDraft, setScopeDraft] = useState("");
  const [test, setTest] = useState(initial.test);
  const [guides, setGuides] = useState<string[]>([]);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [agents, setAgents] = useState<AgentChoices>(initial.agents[initial.target]);

  useEffect(() => {
    api.info().then(setInfo).catch(() => {});
  }, []);

  const switchTarget = (next: Target) => {
    setTarget(next);
    setScope(next === "roblox" ? loadPrefs().robloxScope : []);
    setAgents(loadPrefs().agents[next]);
    setError("");
  };

  const changeAgents = (next: AgentChoices) => {
    setAgents(next);
    const prefs = loadPrefs();
    savePrefs({ ...prefs, agents: { ...prefs.agents, [target]: next } });
  };

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

  const addGuides = async () => {
    const files = await api.pickFiles();
    setGuides([...guides, ...files.filter((f) => !guides.includes(f))]);
  };

  const pendingScope = scopeDraft.trim();
  const finalScope = pendingScope && !scope.includes(pendingScope) ? [...scope, pendingScope] : scope;
  const missing =
    !task.trim()
      ? "Describe the task."
      : target === "folder" && !project.trim()
        ? "Choose the project folder."
        : target === "roblox" && finalScope.length === 0
          ? "Add at least one Studio location the run may change."
          : "";

  const start = async () => {
    if (missing) return setError(missing);
    setStarting(true);
    setError("");
    try {
      const { id } = await api.startRun({ target, project, task, scope: finalScope, test, guides, agents });
      const prefs = loadPrefs();
      savePrefs({
        ...prefs,
        target,
        project: target === "folder" ? project : prefs.project,
        test: target === "folder" ? test : prefs.test,
        robloxScope: target === "roblox" ? finalScope : prefs.robloxScope,
      });
      onStarted(id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const defaultGuides = target === "roblox" ? (info?.robloxGuides ?? []) : (info?.folderGuides ?? []);

  return (
    <div className="page narrow">
      <h1>New run</h1>

      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={target === "folder"} className={target === "folder" ? "on" : ""} onClick={() => switchTarget("folder")}>
          Project folder
        </button>
        <button role="tab" aria-selected={target === "roblox"} className={target === "roblox" ? "on" : ""} onClick={() => switchTarget("roblox")}>
          Roblox Studio
        </button>
      </div>

      <ModelsMenu target={target} choices={agents} onChange={changeAgents} />

      {target === "folder" ? (
        <label className="field">
          <span className="field-label">Project</span>
          <div className="row">
            <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="C:\path\to\your\git\project" spellCheck={false} />
            <button className="btn" onClick={browse}>
              Browse…
            </button>
          </div>
          <span className="hint">
            Must be a git project. The run works on a new branch in a separate copy, so your own files are not touched.
          </span>
        </label>
      ) : (
        <p className="hint block">
          Edits the place that is open in Roblox Studio, live. Save a backup of the place first (File → Save to File).
        </p>
      )}

      <label className="field">
        <span className="field-label">Task</span>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={8}
          placeholder="What should be built or changed? Be as specific as you like."
        />
      </label>

      <div className="field">
        <span className="field-label">
          {target === "roblox" ? "Studio locations the run may change" : "Folders the run may change"}
          {target === "folder" && <span className="muted"> (optional; empty means anywhere)</span>}
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
            placeholder={target === "roblox" ? "ServerScriptService/Combat" : "src/cart"}
            spellCheck={false}
          />
          <button className="btn" onClick={addScope} disabled={!scopeDraft.trim()}>
            Add
          </button>
        </div>
      </div>

      {target === "folder" && (
        <label className="field">
          <span className="field-label">
            Test command <span className="muted">(optional)</span>
          </span>
          <input value={test} onChange={(e) => setTest(e.target.value)} placeholder="npm test" spellCheck={false} />
          <span className="hint">Runs after every build. Failing tests count as findings.</span>
        </label>
      )}

      <div className="field">
        <span className="field-label">Guides</span>
        <ul className="file-list">
          {defaultGuides.map((g) => (
            <li key={g} title={g}>
              {basename(g)} <span className="muted">· always used for {target === "roblox" ? "Roblox" : "project"} runs</span>
            </li>
          ))}
          {guides.map((g) => (
            <li key={g} title={g}>
              {basename(g)}
              <button className="link" onClick={() => setGuides(guides.filter((x) => x !== g))}>
                remove
              </button>
            </li>
          ))}
          <li className="muted">The project's own CLAUDE.md / AGENTS.md is always followed.</li>
        </ul>
        <button className="btn btn-small" onClick={addGuides}>
          Add guide file…
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button className="btn btn-primary" onClick={start} disabled={starting}>
          {starting ? "Starting…" : "Start run"}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
