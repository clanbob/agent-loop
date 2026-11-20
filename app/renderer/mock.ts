import type {
  AgentLoopApi,
  Setup,
  AppEvent,
  Finding,
  LogLine,
  RunDetail,
  RunListItem,
  RunState,
  TimelineEntry,
} from "../shared/api.ts";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const finding = (id: string, severity: Finding["severity"], file: string, line: number, issue: string): Finding => ({
  id,
  severity,
  file,
  line,
  issue,
  suggestion: "",
  repeat_of: null,
});

function timeline(entries: Array<[TimelineEntry["phase"], number, number]>): TimelineEntry[] {
  return entries.map(([phase, round, m]) => ({ phase, round, at: minutesAgo(m) }));
}

const base = (id: string, task: string): RunState => ({
  id,
  task,
  agents: null,
  workspace: {
    kind: "folder",
    project: "C:\\Users\\andre\\projects\\shop-api",
    scope: ["src/cart"],
    guides: [],
    testCommand: "npm test",
    branch: `agentloop/${id}`,
    worktree: `C:\\Users\\andre\\projects\\agent-loop\\worktrees\\${id}`,
  },
  status: "running",
  cursor: { round: 1, step: "build" },
  baselineCommit: "867ad26",
  builderSessionId: "x",
  instructions: null,
  roundsAllowed: 10,
  buildStarted: false,
  currentBuild: null,
  currentSnapshot: null,
  rounds: [],
  error: null,
  endReason: null,
  resultNote: null,
  pausedFor: null,
  timeline: [],
  pid: null,
  startedAt: minutesAgo(30),
  resumedAt: [],
  finishedAt: null,
});

const live: RunState = {
  ...base("2026-11-20T05-10-00", "Add a discount code field to the cart: validate codes against the promotions table and show the discounted total."),
  cursor: { round: 2, step: "build" },
  instructions: "1. src/cart/discount.ts: add applyDiscount(cart, code)...\n2. src/cart/routes.ts: POST /cart/discount (F1)...",
  rounds: [
    {
      round: 1,
      instructions: "1. Create src/cart/discount.ts ...",
      builderSummary: "Created discount.ts with applyDiscount, added the POST /cart/discount route and 9 tests.",
      commit: "a1b2c3d",
      changedFiles: ["src/cart/discount.ts", "src/cart/routes.ts", "test/discount.test.ts"],
      testExitCode: 0,
      findings: [
        finding("F1", "high", "src/cart/routes.ts", 42, "The discount route trusts the client-sent total instead of recomputing it on the server."),
        finding("F2", "medium", "src/cart/discount.ts", 18, "Expired promotion codes are still accepted because expires_at is never checked."),
        finding("F3", "low", "src/cart/discount.ts", 7, "Consider renaming applyDiscount to applyPromotion for consistency."),
      ],
      decisions: [
        { id: "F1", verdict: "fix", reason: "A client could set any price; this is a real security problem." },
        { id: "F2", verdict: "fix", reason: "Accepting expired codes is wrong behaviour the request implies." },
        { id: "F3", verdict: "skip", reason: "Naming preference not required by any guide." },
      ],
      costUsd: 0.42,
    },
  ],
  timeline: timeline([
    ["prepare", 0, 9.5],
    ["judge", 0, 9.4],
    ["build", 1, 8.6],
    ["snapshot", 1, 6.1],
    ["test", 1, 6.0],
    ["review", 1, 5.8],
    ["judge", 1, 4.1],
    ["build", 2, 3.2],
    ["paused", 2, 1.5],
  ]),
  pausedFor: { agent: "Claude (builder)", message: "You've hit your limit · resets 3pm", resetAt: new Date(Date.now() + 95 * 60_000).toISOString(), round: 2 },
};

const clean: RunState = {
  ...base("2026-11-19T22-36-27", "Create slugify.js exporting slugify(text) that turns any string into a URL slug."),
  status: "clean",
  endReason: "rest-skipped",
  startMode: "review",
  startReason: "The request asks to check the existing slugify module rather than add something new.",
  buildsDone: 1,
  cursor: { round: 3, step: "judge-triage" },
  rounds: [
    {
      round: 1,
      instructions: "",
      builderSummary: "Created slugify.js and 23 tests.",
      commit: "1111111",
      changedFiles: ["slugify.js", "slugify.test.js"],
      testExitCode: 0,
      findings: [finding("F1", "high", "slugify.js", 10, "Non-Latin letters are treated as separators, so slugify('Мир') returns ''.")],
      decisions: [{ id: "F1", verdict: "fix", reason: "Corrupts realistic non-English input." }],
      costUsd: 0.21,
    },
    {
      round: 2,
      instructions: "",
      builderSummary: "Switched to Unicode-aware regexes.",
      commit: "2222222",
      changedFiles: ["slugify.js", "slugify.test.js"],
      testExitCode: 0,
      findings: [
        finding("F2", "low", "slugify.js", 3, "slugify({}) returns 'object-object' instead of throwing."),
        finding("F3", "low", "slugify.js", 8, "Does not handle strings longer than 10 MB efficiently."),
      ],
      decisions: [
        { id: "F2", verdict: "skip", reason: "The request only covers strings; input-type hardening is out of scope." },
        { id: "F3", verdict: "skip", reason: "Hypothetical input far outside the request." },
      ],
      costUsd: 0.18,
    },
  ],
  timeline: timeline([
    ["prepare", 0, 64],
    ["judge", 0, 63.9],
    ["build", 1, 62.8],
    ["snapshot", 1, 62.1],
    ["test", 1, 62.0],
    ["review", 1, 61.9],
    ["judge", 1, 60.4],
    ["build", 2, 59.1],
    ["snapshot", 2, 58.2],
    ["test", 2, 58.1],
    ["review", 2, 58.0],
    ["judge", 2, 56.2],
    ["done", 2, 55.0],
  ]),
  resultNote: "The finished code is on branch agentloop/2026-11-19T22-36-27 in C:\\Users\\andre\\projects\\demo.",
  finishedAt: minutesAgo(55),
};

const failed: RunState = {
  ...base("2026-11-19T18-02-11", "Add a cooldown system for abilities with a client UI timer."),
  workspace: { kind: "roblox", scope: ["ServerScriptService/Combat", "ReplicatedStorage/Shared/Combat"], guides: [], testCommand: null },
  status: "stopped",
  error: "changes outside scope",
  cursor: { round: 1, step: "snapshot" },
  timeline: timeline([
    ["prepare", 0, 300],
    ["judge", 0, 299.8],
    ["build", 1, 298.9],
    ["snapshot", 1, 295.2],
    ["stopped", 1, 294.9],
  ]),
  finishedAt: minutesAgo(294.9),
};

const logs: LogLine[] = [
  { at: Date.now() - 200_000, agent: "builder", text: "I'll start by reading the current cart routes." },
  { at: Date.now() - 199_000, agent: "builder", text: "▸ Read  src/cart/routes.ts" },
  { at: Date.now() - 198_000, agent: "builder", text: "▸ Edit  src/cart/routes.ts" },
  { at: Date.now() - 196_000, agent: "builder", text: "▸ Bash  npm test -- discount" },
  { at: Date.now() - 95_000, agent: "builder", text: "✖ You've hit your limit · resets 3pm" },
];

const details: Record<string, RunDetail> = {
  [live.id]: { state: live, status: "running", live: true, pending: { kind: "limit", pause: live.pausedFor! }, folderDeleted: false, logs, finishDone: null },
  [clean.id]: { state: clean, status: "clean", live: false, pending: null, folderDeleted: true, logs: [], finishDone: null },
  [failed.id]: { state: failed, status: "stopped", live: false, pending: null, folderDeleted: false, logs: [], finishDone: null },
};

const DIFF = `diff --git a/src/cart/routes.ts b/src/cart/routes.ts
index 3f2a1b0..9c4d2e1 100644
--- a/src/cart/routes.ts
+++ b/src/cart/routes.ts
@@ -38,8 +38,14 @@ router.post("/cart/checkout", async (req, res) => {
   res.json(order);
 });

-router.post("/cart/discount", async (req, res) => {
-  const total = req.body.total;
+router.post("/cart/discount", async (req, res) => {
+  const { code } = req.body;
+  if (typeof code !== "string") return res.status(400).end();
+  const cart = await carts.get(req.session.cartId);
+  const total = computeTotal(cart);
   const result = await applyDiscount(total, code);
   res.json(result);
 });
`;

const mockSetup: Setup = {
  tools: [
    { id: "roblox-studio", name: "Roblox Studio", server: { command: "cmd.exe", args: ["/d", "/c", "mcp.bat"] }, builtIn: "roblox-studio" },
    { id: "supabase-1", name: "Supabase", server: { command: "cmd", args: ["/c", "npx", "-y", "@supabase/mcp-server-supabase@latest"] } },
    { id: "playwright-1", name: "Playwright", server: { command: "cmd", args: ["/c", "npx", "@playwright/mcp@latest"] } },
  ],
  environments: [
    { id: "project-folder", name: "Project folder", toolIds: [], projectPath: "", notes: "", builtIn: "project" },
    { id: "roblox-studio", name: "Roblox Studio", toolIds: ["roblox-studio"], projectPath: "", notes: "", builtIn: "roblox" },
    { id: "web-app", name: "Shop web app", toolIds: ["supabase-1", "playwright-1"], projectPath: "C:\\Users\\andre\\projects\\shop-api", notes: "" },
  ],
};

export function createMockApi(): AgentLoopApi {
  const listeners = new Set<(e: AppEvent) => void>();
  const item = (d: RunDetail): RunListItem => ({
    id: d.state.id,
    kind: d.state.workspace.kind,
    status: d.status,
    live: d.live,
    paused: Boolean(d.pending),
    title: d.state.task.split("\n")[0],
    round: d.state.cursor.round,
    step: d.state.cursor.step,
    startedAt: d.state.startedAt,
  });
  return {
    info: async () => ({
      judgeModel: "gemini-4-neon",
      guides: ["C:\\Users\\andre\\.claude\\CLAUDE.md", "C:\\Users\\andre\\.claude\\ARCHITECTURE.md", "C:\\Users\\andre\\.claude\\CODE_STYLE.md"],
    }),
    listRuns: async () => Object.values(details).map(item).sort((a, b) => b.id.localeCompare(a.id)),
    getRun: async (id) => details[id] ?? null,
    startRun: async () => {
      throw new Error("This is a preview with sample data. Start runs from the desktop app.");
    },
    resumeRun: async () => {},
    stopRun: async () => {},
    setReviewVerdict: async () => { throw new Error("Review findings in the desktop app."); },
    submitReview: async () => { throw new Error("Review findings in the desktop app."); },
    answerPause: async (id) => {
      details[id].pending = null;
      listeners.forEach((l) => l({ type: "run", id }));
    },
    deleteRun: async () => ({ ok: true, message: "Run deleted." }),
    readDiff: async () => DIFF,
    finishAction: async () => ({ ok: true, message: "Merged." }),
    pickFolder: async () => "C:\\Users\\andre\\projects\\shop-api",
    pickFiles: async () => [],
    checkTools: async () => [
      { name: "Antigravity", ok: true, detail: "1.5.13" },
      { name: "Claude", ok: true, detail: "2.1.329 (Claude Code)" },
      { name: "Codex", ok: true, detail: "codex-cli 0.171.0" },
    ],
    listModels: async () => ({
      antigravity: {
        models: [
          { id: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"] },
          { id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
          { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
          { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)", efforts: [] },
        ],
        defaultModel: "gemini-4-neon",
        defaultEffort: "medium",
      },
      claude: {
        models: [
          { id: "opus", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
          { id: "fable", label: "Fable", efforts: ["low", "medium", "high", "xhigh", "max"] },
          { id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high", "xhigh", "max"] },
        ],
        defaultModel: "opus",
        defaultEffort: "medium",
      },
      codex: {
        models: [
          { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
          { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
          { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
        ],
        defaultModel: "gpt-6.2-astra",
        defaultEffort: "medium",
      },
    }),
    getSetup: async () => ({ tools: [...mockSetup.tools], environments: [...mockSetup.environments] }),
    saveTool: async (input) => {
      const tool = { id: input.id ?? `tool-${mockSetup.tools.length + 1}`, name: input.name, server: input.server };
      mockSetup.tools = [...mockSetup.tools.filter((t) => t.id !== tool.id), tool];
      return tool;
    },
    deleteTool: async (id) => {
      mockSetup.tools = mockSetup.tools.filter((t) => t.id !== id);
      mockSetup.environments = mockSetup.environments.map((e) => ({ ...e, toolIds: e.toolIds.filter((t) => t !== id) }));
    },
    saveEnvironment: async (input) => {
      const env = { id: input.id ?? `env-${mockSetup.environments.length + 1}`, name: input.name, toolIds: input.toolIds, projectPath: input.projectPath, notes: input.notes };
      const i = mockSetup.environments.findIndex((e) => e.id === env.id);
      if (i >= 0) mockSetup.environments[i] = { ...mockSetup.environments[i], ...env };
      else mockSetup.environments.push(env);
      return env;
    },
    deleteEnvironment: async (id) => {
      mockSetup.environments = mockSetup.environments.filter((e) => e.id !== id);
    },
    parseMcp: async (text, name) => {
      try {
        const data = JSON.parse(text);
        const map = data.mcpServers ?? data.servers ?? (data.command || data.url ? { [name || "server"]: data } : data);
        return {
          servers: map,
          problems: [],
          described: Object.entries(map).map(([n, s]) => ({ name: n, summary: (s as { url?: string; command?: string; args?: string[] }).url ?? [(s as { command: string }).command, ...((s as { args?: string[] }).args ?? [])].join(" ") })),
        };
      } catch {
        return text.trim() ? { servers: { [name || "server"]: { command: text.trim().split(" ")[0], args: text.trim().split(" ").slice(1) } }, problems: [], described: [{ name: name || "server", summary: text.trim() }] } : { servers: {}, problems: [], described: [] };
      }
    },
    testMcp: async (servers) =>
      Object.keys(servers).map((name, i) => (i === 0 ? { name, ok: true, tools: ["query", "list_tables"], detail: "12 tools" } : { name, ok: false, tools: [], detail: "The server stopped right away. Check the command is installed and correct, and that any keys it needs are set." })),
    onEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
