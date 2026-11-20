import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "../config.ts";

export interface StudioInfo {
  id: string;
  name: string;
  mode: string;
  placeId?: number;
}

const STUDIO_WAIT_MS = Number(process.env.AGENT_LOOP_STUDIO_WAIT_MS) || 45_000;
const STUDIO_POLL_MS = 1_000;

function pick(studios: StudioInfo[], placeId: number | null): StudioInfo | undefined {
  return placeId == null ? studios[0] : studios.find((s) => s.placeId === placeId);
}

export class StudioClient {
  private client: Client;
  private transport: StdioClientTransport;
  studioId = "";

  private constructor(client: Client, transport: StdioClientTransport) {
    this.client = client;
    this.transport = transport;
  }

  static async connect(config: Config): Promise<StudioClient> {
    if (!config.roblox.mcpCommand.trim()) {
      throw new Error(
        "The Roblox Studio MCP command is not set on this computer. Edit the Roblox Studio tool (in the Roblox Studio environment) and paste its command.",
      );
    }
    const transport = new StdioClientTransport({
      command: config.roblox.mcpCommand,
      args: config.roblox.mcpArgs,
      env: process.env as Record<string, string>,
      stderr: "ignore",
    });
    const client = new Client({ name: "agent-loop", version: "0.1.0" });
    await client.connect(transport);
    const studio = new StudioClient(client, transport);
    try {
      await studio.selectStudio(config.roblox.placeId);
    } catch (err) {
      await studio.close();
      throw err;
    }
    return studio;
  }

  private async callText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (result.isError) throw new Error(`Studio MCP ${name} failed: ${text}`);
    return text;
  }

  async listStudios(): Promise<StudioInfo[]> {
    const text = await this.callText("list_roblox_studios", {});
    return (JSON.parse(text).studios ?? []) as StudioInfo[];
  }

  // The first StudioMCP process to start hosts the connection Studio joins. When the host exits
  // (for example the builder's, at the end of a build), this process takes over and Studio
  // needs a few seconds to reconnect, so an empty list right after starting is not final.
  private async selectStudio(placeId: number | null): Promise<void> {
    const deadline = Date.now() + STUDIO_WAIT_MS;
    let studios = await this.listStudios();
    let match = pick(studios, placeId);
    while (!match && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, STUDIO_POLL_MS));
      studios = await this.listStudios();
      match = pick(studios, placeId);
    }
    const waited = `after waiting ${Math.round(STUDIO_WAIT_MS / 1000)} seconds`;
    if (studios.length === 0) {
      throw new Error(`No Roblox Studio connected ${waited}. Open the place in Studio, check that its MCP server is turned on, then resume.`);
    }
    if (!match) {
      throw new Error(
        `Studio with placeId ${placeId} is not open (${waited}). Open studios: ${studios.map((s) => s.name).join(", ")}`,
      );
    }
    if (match.mode !== "Edit") throw new Error(`Studio "${match.name}" is in ${match.mode} mode. Stop play mode first.`);
    this.studioId = match.id;
  }

  async runLuau(code: string): Promise<string> {
    return this.callText("execute_luau", { code, datamodel_type: "Edit", studio_id: this.studioId });
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
    await this.transport.close().catch(() => {});
  }
}
