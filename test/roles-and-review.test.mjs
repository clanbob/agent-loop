import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, withAgentChoices } from "../src/config.ts";
import { runBuilder } from "../src/agents/builder.ts";
import { AgentLoop } from "../src/loop.ts";
import { DEFAULT_CHOICES, PROVIDERS, ROLES } from "../src/roles.ts";
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
    start: (choices, manual = false) => AgentLoop.start(config, "test", "Check the inventory", workspace, hooks, choices, manual),
  };
}

function oneModel(provider) {
  return Object.fromEntries(ROLES.map((r) => [r, { provider, model: "custom-model", effort: null }]));
}

for (const provider of PROVIDERS) {
  test(`one ${provider} model can plan, review, triage and build`, async (t) => {
    const env = setup(t);
    const state = await env.start(oneModel(provider)).run();
    assert.equal(state.status, "clean", state.error);
    assert.equal(state.endReason, "no-findings");
    const calls = env.calls();
    assert.deepEqual(calls.map((c) => c.step), ["plan", "review", "triage", "build", "review"]);
    assert(calls.every((c) => c.provider === provider && c.model === "custom-model"));
    const build = calls.find((c) => c.step === "build");
    assert.match(build.input, /Incorrect inventory total/);
    assert.doesNotMatch(build.input, /Rename inventory entry/);
    if (provider === "codex") assert(calls.every((c) => c.args.includes("read-only"))); // MCP-only workspace
    if (provider === "claude") assert(build.args.includes("--strict-mcp-config"));
  });
}

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
  const loop = env.start(choices, true);
  const first = await pauseAtReview(loop);
  assert.deepEqual(env.calls().map((c) => c.step), ["plan", "review"]);
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
  assert.equal(env.calls().length, 2);
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
  assert.deepEqual(calls.map((c) => c.provider), ["codex", "claude", "antigravity", "claude"]);
  assert.equal(calls[2].model, "gemini-4-neon-medium");
  assert.match(calls[2].input, /Incorrect inventory total/);
  assert.doesNotMatch(calls[2].input, /Rename inventory entry/);
});

test("submitting all Skip finishes without a triage or build call", async (t) => {
  const env = setup(t);
  const loop = env.start(DEFAULT_CHOICES, true);
  const { done } = await pauseAtReview(loop);
  for (const f of loop.state.rounds[0].findings) loop.setReviewVerdict(1, f.id, "skip");
  loop.submitReview(1);
  const result = await done;
  assert.equal(result.status, "clean", result.error);
  assert.equal(result.endReason, "rest-skipped");
  assert.deepEqual(env.calls().map((c) => c.step), ["plan", "review"]);
});
