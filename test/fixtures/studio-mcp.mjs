// A stand-in for StudioMCP. Studio "reconnects" after FAKE_STUDIO_EMPTY_CALLS empty answers.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const emptyCalls = Number(process.env.FAKE_STUDIO_EMPTY_CALLS ?? 0);
let calls = 0;
const server = new Server({ name: "fake-studio", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "list_roblox_studios", inputSchema: { type: "object", properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  calls += 1;
  const studios = calls > emptyCalls ? [{ id: "studio-1", name: "Test place", mode: "Edit", placeId: 123 }] : [];
  return { content: [{ type: "text", text: JSON.stringify({ studios }) }] };
});
await server.connect(new StdioServerTransport());
