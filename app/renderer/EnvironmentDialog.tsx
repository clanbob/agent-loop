import { useEffect, useRef, useState } from "react";
import type { Environment, McpServerTest, McpTool, ParsedServers, Setup } from "../shared/api.ts";
import { FolderOpen, Plus, X } from "lucide-react";
import { api, errorText } from "./api.ts";

const PLACEHOLDER = `Paste MCP server settings, for example:

{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": ["-y", "@supabase/mcp-server-supabase@latest"],
      "env": { "SUPABASE_ACCESS_TOKEN": "..." }
    }
  }
}

A single server, a URL or a command line
(npx -y @playwright/mcp@latest) also works.
Several servers at once become several tools.`;

function unwrap(tool: McpTool): object {
  const s = tool.server;
  if ("url" in s) return s;
  const args = s.args ?? [];
  return s.command === "cmd" && args[0] === "/c" ? { ...s, command: args[1], args: args.slice(2) } : s;
}

function describe(tool: McpTool): string {
  const s = tool.server;
  if ("url" in s) return s.url;
  const args = s.args ?? [];
  return (s.command === "cmd" && args[0] === "/c" ? args.slice(1) : [s.command, ...args]).join(" ");
}

export function EnvironmentDialog({
  editing,
  setup,
  onClose,
  onSaved,
  onDeleted,
  onSetupChanged,
}: {
  editing: Environment | null;
  setup: Setup;
  onClose: () => void;
  onSaved: (env: Environment) => void;
  onDeleted: (id: string) => void;
  onSetupChanged: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [toolIds, setToolIds] = useState<string[]>(editing?.toolIds ?? []);
  const [projectPath, setProjectPath] = useState(editing?.projectPath ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [tests, setTests] = useState<Record<string, McpServerTest>>({});
  const [testing, setTesting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pasteName, setPasteName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [parsed, setParsed] = useState<ParsedServers | null>(null);
  const [editingTool, setEditingTool] = useState<McpTool | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [closing, setClosing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  const tools = setup.tools;
  const isProjectBuiltIn = editing?.builtIn === "project";

  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  useEffect(() => {
    if (!adding) return;
    const timer = setTimeout(() => {
      api
        .parseMcp(pasteText, pasteName.trim() || "tool")
        .then(setParsed)
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [pasteText, pasteName, adding]);

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 160);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (id: string) => setToolIds(toolIds.includes(id) ? toolIds.filter((t) => t !== id) : [...toolIds, id]);

  const testSelected = async () => {
    const selected = tools.filter((t) => toolIds.includes(t.id));
    if (selected.length === 0) return;
    setTesting(true);
    setError("");
    try {
      const results = await api.testMcp(Object.fromEntries(selected.map((t) => [t.id, t.server])));
      setTests((prev) => ({ ...prev, ...Object.fromEntries(results.map((r) => [r.name, r])) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTesting(false);
    }
  };

  const startEditTool = (tool: McpTool) => {
    setEditingTool(tool);
    setPasteName(tool.name);
    setPasteText(JSON.stringify(unwrap(tool), null, 2));
    setAdding(true);
  };

  const closePaste = () => {
    setAdding(false);
    setEditingTool(null);
    setPasteText("");
    setPasteName("");
    setParsed(null);
  };

  const addTools = async () => {
    if (!parsed || parsed.described.length === 0) return;
    setError("");
    if (editingTool) {
      try {
        const [server] = Object.values(parsed.servers);
        const saved = await api.saveTool({ id: editingTool.id, name: pasteName.trim() || editingTool.name, server });
        onSetupChanged();
        const [result] = await api.testMcp({ [saved.id]: saved.server });
        if (result) setTests((prev) => ({ ...prev, [saved.id]: result }));
        closePaste();
      } catch (err) {
        setError(errorText(err));
      }
      return;
    }
    try {
      const entries = Object.entries(parsed.servers);
      const added: McpTool[] = [];
      for (const [serverName, server] of entries) {
        const toolName = entries.length === 1 && pasteName.trim() ? pasteName.trim() : serverName;
        added.push(await api.saveTool({ id: null, name: toolName, server }));
      }
      setToolIds([...toolIds, ...added.map((t) => t.id)]);
      onSetupChanged();
      const results = await api.testMcp(Object.fromEntries(added.map((t) => [t.id, t.server])));
      setTests((prev) => ({ ...prev, ...Object.fromEntries(results.map((r) => [r.name, r])) }));
      setAdding(false);
      setPasteText("");
      setPasteName("");
      setParsed(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const removeTool = async (tool: McpTool) => {
    if (!window.confirm(`Remove "${tool.name}" from your tools? It is also removed from every environment that uses it.`)) return;
    try {
      await api.deleteTool(tool.id);
      setToolIds(toolIds.filter((t) => t !== tool.id));
      onSetupChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const browse = async () => {
    const folder = await api.pickFolder();
    if (folder) setProjectPath(folder);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      onSaved(await api.saveEnvironment({ id: editing?.id ?? null, name, toolIds, projectPath, notes }));
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing || !window.confirm(`Delete the "${editing.name}" environment? Your MCP tools stay saved, and runs that used it keep working.`)) return;
    try {
      await api.deleteEnvironment(editing.id);
      onDeleted(editing.id);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className={`overlay ${closing ? "closing" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="env-title">
        <div className="dialog-head">
          <h2 id="env-title">{editing ? `Edit ${editing.name}` : "New environment"}</h2>
          <button className="icon-btn" aria-label="Close" onClick={close}>
            <X />
          </button>
        </div>

        <label className="field">
          <span className="field-label">Name</span>
          <input ref={nameInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Web app with Supabase" />
        </label>

        <div className="field">
          <span className="field-label">MCP tools</span>
          {tools.length === 0 && <p className="hint">No tools saved yet. Add one below.</p>}
          <ul className="tool-picker">
            {tools.map((tool) => {
              const on = toolIds.includes(tool.id);
              const result = tests[tool.id];
              return (
                <li key={tool.id} className={on ? "on" : ""}>
                  <label>
                    <input type="checkbox" checked={on} onChange={() => toggle(tool.id)} />
                    <span className="check" aria-hidden />
                    <span className="tool-name">{tool.name}</span>
                    <code className="server-cmd">{describe(tool)}</code>
                  </label>
                  {result && (
                    <span className={`tool-test ${result.ok ? "ok-text" : "error-text"}`} title={result.detail}>
                      {result.ok ? result.detail : "Failed"}
                    </span>
                  )}
                  <button className="link-btn" onClick={() => startEditTool(tool)} aria-label={`Edit ${tool.name}`}>
                    Edit
                  </button>
                  {!tool.builtIn && (
                    <button className="icon-btn small" aria-label={`Remove ${tool.name}`} title="Remove from your tools" onClick={() => removeTool(tool)}>
                      <X size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {Object.values(tests).some((t) => !t.ok) && (
            <p className="error-text small">
              {Object.values(tests)
                .filter((t) => !t.ok)
                .map((t) => `${tools.find((x) => x.id === t.name)?.name ?? t.name}: ${t.detail}`)
                .join(" ")}
            </p>
          )}

          {adding && (
            <div className="add-tool">
              <input value={pasteName} onChange={(e) => setPasteName(e.target.value)} placeholder="Tool name (optional for JSON with names)" />
              <textarea className="code" value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={8} placeholder={PLACEHOLDER} spellCheck={false} />
              {parsed && (parsed.described.length > 0 || parsed.problems.length > 0) && (
                <ul className="server-list">
                  {parsed.described.map((s) => (
                    <li key={s.name}>
                      <span className="dot dot-stopped" />
                      <strong>{parsed.described.length === 1 && pasteName.trim() ? pasteName.trim() : s.name}</strong>
                      <code className="server-cmd">{s.summary}</code>
                    </li>
                  ))}
                  {parsed.problems.map((p) => (
                    <li key={p} className="error-text small">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
              <div className="row-actions">
                <button
                  className="btn btn-small btn-primary"
                  onClick={addTools}
                  disabled={!parsed || parsed.described.length === 0 || (Boolean(editingTool) && parsed.described.length > 1)}
                >
                  {editingTool
                    ? `Save ${editingTool.name}`
                    : `Add ${parsed && parsed.described.length > 1 ? `${parsed.described.length} tools` : "tool"}`}
                </button>
                <button className="btn btn-small btn-ghost" onClick={closePaste}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="row-actions">
            {!adding && (
              <button className="btn btn-small" onClick={() => setAdding(true)}>
                <Plus />
                Add MCP tool
              </button>
            )}
            <button className="btn btn-small btn-ghost" onClick={testSelected} disabled={testing || toolIds.length === 0}>
              {testing ? "Testing" : "Test selected"}
            </button>
          </div>
        </div>

        <label className="field">
          <span className="field-label">
            Project folder <span className="muted">(optional)</span>
          </span>
          <div className="row">
            <input value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder="Filled in for each run; can be changed then" spellCheck={false} />
            <button className="btn" onClick={browse}>
              <FolderOpen />
              Browse
            </button>
          </div>
          <span className="hint">
            {isProjectBuiltIn
              ? "Runs work on a new branch of the project."
              : "With a project: code goes on a new branch and the tools help the builder. Without one: the builder works only through the tools, and the reviewer checks the work through them."}
          </span>
        </label>

        <label className="field">
          <span className="field-label">
            How the agents should use the tools <span className="muted">(optional)</span>
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="For example: check the real table schema with the supabase tools before writing any query."
          />
        </label>

        {error && <p className="error">{error}</p>}

        <div className="dialog-actions">
          {editing && !isProjectBuiltIn && (
            <button className="btn btn-danger" onClick={remove}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Saving" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
