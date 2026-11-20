import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.AGENT_LOOP_STUDIO_WAIT_MS = "3000";
const { StudioClient } = await import("../src/studio/client.ts");

const fixture = fileURLToPath(new URL("./fixtures/studio-mcp.mjs", import.meta.url));

function config(emptyCalls) {
  process.env.FAKE_STUDIO_EMPTY_CALLS = String(emptyCalls);
  return { roblox: { mcpCommand: process.execPath, mcpArgs: [fixture], placeId: 123 } };
}

test("waits for Studio to reconnect when the MCP host has just changed", async () => {
  const studio = await StudioClient.connect(config(2));
  try {
    assert.equal(studio.studioId, "studio-1");
  } finally {
    await studio.close();
  }
});

test("gives up with a clear message when Studio never connects", async () => {
  const started = Date.now();
  await assert.rejects(StudioClient.connect(config(1000)), /No Roblox Studio connected after waiting 3 seconds/);
  assert(Date.now() - started >= 3000);
});
