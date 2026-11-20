import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, withAgentChoices } from "../src/config.ts";
import { runReviewer } from "../src/agents/reviewer.ts";
import { runBuilder } from "../src/agents/builder.ts";
import { modelCatalog } from "../src/models.ts";
import { AgentLoop } from "../src/loop.ts";
import { commitAll, ensureRepo } from "../src/git.ts";
import { DEFAULT_CHOICES, PROVIDERS, ROLES } from "../src/roles.ts";
import { folderSpec } from "../src/workspace/folder.ts";
import { toolsSpec } from "../src/workspace/tools.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/provider.cjs", import.meta.url));
const hooks = { confirmContinue: async () => false, waitForResume: async () => false };

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-loop-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = path.join(dir, "calls.jsonl");
  const config = loadConfig(root, undefined, dir);
  config.deleteRunFolder = "never";
  for (const agent of Object.values(config.agents)) {
    const launcher = path.join(dir, agent.provider + ".cjs");
    writeFileSync(launcher, `#!/usr/bin/env node\nrequire(${JSON.stringify(fixture)}).run(${JSON.stringify(agent.provider)}, ${JSON.stringify(trace)}, process.argv.slice(2));\n`, { mode: 0o700 });
    agent.command = launcher;
    if (process.platform === "win32") {
      agent.command += ".cmd";
      writeFileSync(agent.command, `@"${process.execPath}" "${launcher}" %*\r\n`);
    }
  }
  const workspace = toolsSpec(config, "test", [], [], { name: "Inventory", servers: { inventory: { command: "fixture" } }, notes: "" });
  return {
    config, calls: () => readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    start: (choices, manual = false, task = "Is the inventory total correct?") => AgentLoop.start(config, "test", task, workspace, hooks, choices, manual),
  };
}

function oneModel(provider) {
  return Object.fromEntries(ROLES.map((r) => [r, { provider, model: "custom-model", effort: null }]));
}

test("model lists come from each CLI, including exact Claude versions and Gemini effort variants", async (t) => {
  const { config } = setup(t);
  const catalog = await modelCatalog(config);
  assert.deepEqual(catalog.codex.models.map((m) => m.id), ["codex-new", "codex-small"]);
  assert.deepEqual(catalog.claude.models.map((m) => m.id), ["opus", "claude-opus-example", "another-model"]);
  assert.deepEqual(catalog.claude.models[1].efforts, ["high", "max"]);
  assert.deepEqual(catalog.antigravity.models, [
    { id: "gemini-example", label: "Gemini Example", efforts: ["low", "high"] },
    { id: "gemini-flash", label: "Gemini Flash", efforts: [] },
  ]);

  writeFileSync(path.join(config.dataDir, "antigravity.cjs"), '#!/usr/bin/env node\nconsole.log("gemini-new\\tNew Gemini");');
  assert.equal(await modelCatalog(config), catalog);
  const refreshed = await modelCatalog(config, true);
  assert.deepEqual(refreshed.antigravity.models.map((m) => m.id), ["gemini-new"]);
  config.agents.judge.command = path.join(config.dataDir, "unavailable");
  const offline = await modelCatalog(config, true);
  assert.equal(offline.antigravity.source, "cache");
  assert.deepEqual(offline.antigravity.models, refreshed.antigravity.models);
});

test("when discovery is unavailable the picker has multiple labeled suggestions", async (t) => {
  const { config } = setup(t);
  config.agents.judge.command = path.join(config.dataDir, "unavailable");
  config.agents.builder.command = path.join(config.dataDir, "unavailable");
  const catalog = await modelCatalog(config);
  for (const provider of ["antigravity", "claude"]) {
    assert.equal(catalog[provider].source, "suggestions");
    assert(catalog[provider].models.length > 1);
  }
  assert.equal(catalog.codex.source, "cli");
});

for (const provider of PROVIDERS) {
  test(`one ${provider} model can route an ambiguous request, review, triage and build`, async (t) => {
    const env = setup(t);
    const state = await env.start(oneModel(provider)).run();
    assert.equal(state.status, "clean", state.error);
    assert.equal(state.endReason, "no-findings");
    const calls = env.calls();
    assert.deepEqual(calls.map((c) => c.step), ["route", "review", "triage", "build", "review"]);
    assert(calls.every((c) => c.provider === provider && c.model === "custom-model"));
    const [route, review, triage] = calls;
    assert.notEqual(route.cwd, review.cwd);
    assert.doesNotMatch(route.input, /MCP tools|inventory \(fixture\)|files currently in the project/i);
    assert.match(review.input, /<request>\s*Is the inventory total correct\?\s*<\/request>/);
    assert.doesNotMatch(review.input, /review_focus|request asks for an inspection/i);
    assert.match(triage.input, /Incorrect inventory total/);
    if (provider === "claude") assert.equal(route.args[route.args.indexOf("--tools") + 1], "");
    if (provider === "codex") assert(route.args.includes("features.shell_tool=false"));
    if (provider === "antigravity") {
      const settings = JSON.parse(readFileSync(route.args[route.args.indexOf("--settings") + 1], "utf8"));
      assert(settings.permissions.deny.includes("read_file(*)"));
    }
    const build = calls.find((c) => c.step === "build");
    assert.match(build.input, /Incorrect inventory total/);
    assert.doesNotMatch(build.input, /Rename inventory entry/);
    if (provider === "codex") assert(calls.every((c) => c.args.includes("read-only"))); // MCP-only workspace
    if (provider === "claude") assert(build.args.includes("--strict-mcp-config"));
  });
}

test("a Zone diagnostic sends the original request straight to the reviewer in the project worktree", async (t) => {
  const { config, calls } = setup(t);
  const project = path.join(config.dataDir, "project");
  const scripts = path.join(project, "ReplicatedStorage");
  mkdirSync(scripts, { recursive: true });
  const source = "return { activeZones = {} }";
  writeFileSync(path.join(scripts, "Zone.luau"), source);
  ensureRepo(project);
  commitAll(project, "Add Zone module");
  const workspace = folderSpec(config, "zone-review", project, ["ReplicatedStorage"], [], null);
  const task = "Run a complete diagnostic review of the zone module. Look for optimizations.";
  const loop = AgentLoop.start(config, "zone-review", task, workspace, hooks, DEFAULT_CHOICES);
  const state = await loop.run();
  assert.equal(state.status, "clean", state.error);
  assert.equal(state.endReason, "no-findings");
  assert.equal(state.startMode, "review");
  assert.deepEqual(state.timeline.map((t) => t.phase), ["prepare", "snapshot", "review", "done"]);
  const [review] = calls();
  assert.deepEqual(calls().map((c) => [c.step, c.provider]), [["review", DEFAULT_CHOICES.reviewer.provider]]);
  assert.equal(review.cwd, workspace.worktree);
  assert(review.input.includes(task));
  assert.match(review.input, /Inspect the existing code/);
  assert.doesNotMatch(review.input, /code changed or added|<review_focus>/);
  const result = JSON.parse(readFileSync(path.join(loop.runDir, "round-01", "review.json"), "utf8"));
  assert.equal(result.summary, source);
});

for (const [task, needsRouting] of [
  ["Build a review dashboard for the inventory.", false],
  ["Build: review the inventory and implement a review dashboard.", false],
  ["Review the inventory and then implement a review dashboard.", true],
]) {
  test(`the build plan reaches the builder for "${task}"`, async (t) => {
    const env = setup(t);
    const state = await env.start(DEFAULT_CHOICES, false, task).run();
    assert.equal(state.status, "clean", state.error);
    assert.equal(state.startMode, "build");
    const calls = env.calls();
    assert.deepEqual(calls.map((c) => c.step), [...(needsRouting ? ["route"] : []), "plan", "build", "review", "triage", "build", "review"]);
    const [plan, build, review] = calls.slice(needsRouting ? 1 : 0);
    assert.equal(plan.cwd, build.cwd);
    assert.match(build.input, /Add the requested inventory dashboard to the existing interface/);
    assert.match(review.input, /Review the code changed or added/);
    assert.doesNotMatch(review.input, /Add the requested inventory dashboard to the existing interface/);
  });
}

test("resuming an older first review drops the judge's saved brief", async (t) => {
  const env = setup(t);
  const old = env.start(DEFAULT_CHOICES);
  mkdirSync(old.runDir, { recursive: true });
  mkdirSync(old.state.workspace.workDir, { recursive: true });
  writeFileSync(path.join(old.runDir, "run.json"), JSON.stringify({
    ...old.state, status: "stopped", pid: null, baselineCommit: "start", startMode: "review",
    cursor: { round: 1, step: "review" }, instructions: "Old judge verdict about an unrelated script.",
  }));
  const state = await AgentLoop.resume(env.config, old.state.id, hooks).run();
  assert.equal(state.status, "clean", state.error);
  assert.equal(state.rounds[0].instructions, "");
  assert.deepEqual(env.calls().map((c) => c.step), ["review", "triage", "build", "review"]);
  assert.doesNotMatch(env.calls()[0].input, /Old judge verdict/);
});

test("file builders use the selected provider's edit mode in the project directory", async (t) => {
  const env = setup(t);
  const workDir = path.join(env.config.dataDir, "project");
  mkdirSync(workDir);
  const systemFile = path.join(env.config.dataDir, "system.md");
  writeFileSync(systemFile, "Edit only the inventory files.");
  const builder = { mcpServers: {}, allowedTools: ["Read", "Edit", "Write"], disallowedTools: [], addDirs: [] };
  for (const provider of ["codex", "antigravity"]) {
    const config = withAgentChoices(env.config, oneModel(provider));
    const ctx = { config, runDir: config.dataDir, roundDir: config.dataDir, workDir, guides: [], signal: new AbortController().signal };
    await runBuilder(ctx, builder, "Update the inventory.", systemFile, { id: "test", resume: false });
    const call = env.calls().at(-1);
    assert.equal(call.cwd, workDir);
    assert(call.args.includes(provider === "codex" ? "workspace-write" : "accept-edits"));
    assert.match(call.input, /Edit only the inventory files/);
  }
});

test("Antigravity receives the entire Studio review on stdin, beyond the Windows command-line limit", async (t) => {
  const env = setup(t);
  const config = withAgentChoices(env.config, oneModel("antigravity"));
  const dir = config.dataDir;
  const ctx = { config, runDir: dir, roundDir: dir, workDir: dir, guides: [], signal: new AbortController().signal };
  const prompt = "Review the Zone module.\n" + 'local zone = "温室" -- %PATH% & flags\n'.repeat(6000);
  const review = await runReviewer(ctx, prompt);
  assert.equal(review.findings.length, 2);
  const [call] = env.calls();
  assert.equal(call.input, prompt);
  assert(!call.args.some((arg) => arg.includes("Review the Zone module")));
});

test("a saved run without provider IDs still uses its original three commands", (t) => {
  const { config } = setup(t);
  const legacy = Object.fromEntries(ROLES.map((r) => [r, { model: r + "-model", effort: "high" }]));
  const resolved = withAgentChoices(config, legacy);
  for (const role of ROLES) {
    assert.equal(resolved.agents[role].command, config.agents[role].command);
    assert.equal(resolved.agents[role].provider, DEFAULT_CHOICES[role].provider);
    assert.equal(resolved.agents[role].model, role + "-model");
  }
});

async function pauseAtReview(loop) {
  const paused = once(loop, "manualReview");
  const done = loop.run();
  await Promise.race([paused, done.then((s) => { throw Error(s.error ?? "Run finished before manual review"); })]);
  return { done };
}

test("manual decisions survive a stop, require submission, and send only chosen findings", async (t) => {
  const env = setup(t);
  const choices = { judge: DEFAULT_CHOICES.reviewer, reviewer: DEFAULT_CHOICES.builder, builder: DEFAULT_CHOICES.judge };
  const loop = env.start(choices, true, "Can you do a complete diagnostic scan and review of the zone module?");
  const first = await pauseAtReview(loop);
  assert.deepEqual(env.calls().map((c) => c.step), ["review"]);
  assert.throws(() => loop.submitReview(1), /every finding/);
  assert.throws(() => loop.setReviewVerdict(2, "F1", "fix"), /no longer/);
  assert.throws(() => loop.setReviewVerdict(1, "unknown", "skip"), /Unknown finding/);
  loop.setReviewVerdict(1, "F1", "skip");
  loop.setReviewVerdict(1, "F2", "skip");
  loop.stop();
  assert.equal((await first.done).status, "stopped");

  const resumed = AgentLoop.resume(env.config, loop.state.id, hooks);
  const second = await pauseAtReview(resumed);
  assert.deepEqual(resumed.state.rounds[0].reviewDraft.map((v) => v.verdict), ["skip", "skip"]);
  resumed.setReviewVerdict(1, "F1", "fix");
  assert.equal(env.calls().length, 1);
  // A failed checkpoint must leave the gate open so the same submission can be retried.
  const temporaryStateFile = path.join(resumed.runDir, "run.json.tmp");
  mkdirSync(temporaryStateFile);
  assert.throws(() => resumed.submitReview(1));
  assert.equal(resumed.pendingReviewRound, 1);
  rmSync(temporaryStateFile, { recursive: true });
  resumed.submitReview(1);
  assert.throws(() => resumed.submitReview(1), /no longer/);
  const state = await second.done;
  assert.equal(state.status, "clean", state.error);
  assert.deepEqual(state.agents, choices);
  assert.deepEqual(state.rounds[0].decisions.map((d) => d.verdict), ["fix", "skip"]);
  const calls = env.calls();
  assert.deepEqual(calls.map((c) => c.provider), ["claude", "antigravity", "claude"]);
  assert.equal(calls[1].model, "gemini-4-neon-medium");
  assert.match(calls[1].input, /Incorrect inventory total/);
  assert.doesNotMatch(calls[1].input, /Rename inventory entry/);
});

test("submitting all Skip finishes without a triage or build call", async (t) => {
  const env = setup(t);
  const loop = env.start(DEFAULT_CHOICES, true, "Review: Build a list of inventory problems.");
  const { done } = await pauseAtReview(loop);
  for (const f of loop.state.rounds[0].findings) loop.setReviewVerdict(1, f.id, "skip");
  loop.submitReview(1);
  const result = await done;
  assert.equal(result.status, "clean", result.error);
  assert.equal(result.endReason, "rest-skipped");
  assert.deepEqual(env.calls().map((c) => c.step), ["review"]);
});
