import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Config } from "../../src/config.ts";
import { normalizeServers, safeServerName, type McpServer, type McpServers } from "../../src/mcp.ts";
import type { Environment, EnvironmentInput, McpTool, Setup, ToolInput } from "../shared/api.ts";

const ROBLOX_TOOL_ID = "roblox-studio";

interface StoreFile {
  version: 2;
  tools: McpTool[];
  environments: Environment[];
}

function newId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
  return `${slug}-${randomBytes(3).toString("hex")}`;
}

export class EnvironmentStore {
  private file: string;
  private config: Config;

  constructor(dataDir: string, config: Config) {
    this.file = path.join(dataDir, "environments.json");
    this.config = config;
  }

  private seed(): StoreFile {
    return {
      version: 2,
      tools: [
        {
          id: ROBLOX_TOOL_ID,
          name: "Roblox Studio",
          server: { command: this.config.roblox.mcpCommand, args: this.config.roblox.mcpArgs },
          builtIn: "roblox-studio",
        },
      ],
      environments: [
        { id: "project-folder", name: "Project folder", toolIds: [], projectPath: "", notes: "", builtIn: "project" },
        { id: "roblox-studio", name: "Roblox Studio", toolIds: [ROBLOX_TOOL_ID], projectPath: "", notes: "", builtIn: "roblox" },
      ],
    };
  }

  private read(): StoreFile {
    if (!existsSync(this.file)) return this.seed();
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (data.version === 2) return data as StoreFile;
      const seeded = this.seed();
      for (const old of (data.environments ?? []) as Array<{ name: string; servers?: McpServers; notes?: string }>) {
        const toolIds: string[] = [];
        for (const [name, server] of Object.entries(old.servers ?? {})) {
          const tool: McpTool = { id: newId(name), name, server };
          seeded.tools.push(tool);
          toolIds.push(tool.id);
        }
        seeded.environments.push({ id: newId(old.name), name: old.name, toolIds, projectPath: "", notes: old.notes ?? "" });
      }
      return seeded;
    } catch {
      return this.seed();
    }
  }

  private write(data: StoreFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(data, null, 2), "utf8");
  }

  setup(): Setup {
    const data = this.read();
    return { tools: data.tools, environments: data.environments };
  }

  environment(id: string): Environment | null {
    return this.read().environments.find((e) => e.id === id) ?? null;
  }

  saveTool(input: ToolInput): McpTool {
    const name = input.name.trim();
    if (!name) throw new Error("Give the tool a name.");
    const data = this.read();
    if (data.tools.some((t) => t.id !== input.id && t.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`There is already a tool called "${name}".`);
    }
    const existing = data.tools.find((t) => t.id === input.id);
    const server = normalizeServers({ x: input.server }).x;
    const tool: McpTool = existing ? { ...existing, name, server } : { id: newId(name), name, server };
    data.tools = existing ? data.tools.map((t) => (t.id === tool.id ? tool : t)) : [...data.tools, tool];
    this.write(data);
    return tool;
  }

  deleteTool(id: string): void {
    const data = this.read();
    if (data.tools.find((t) => t.id === id)?.builtIn) throw new Error("The Roblox Studio tool is built in and cannot be deleted.");
    data.tools = data.tools.filter((t) => t.id !== id);
    data.environments = data.environments.map((e) => ({ ...e, toolIds: e.toolIds.filter((t) => t !== id) }));
    this.write(data);
  }

  saveEnvironment(input: EnvironmentInput): Environment {
    const name = input.name.trim();
    if (!name) throw new Error("Give the environment a name.");
    const data = this.read();
    if (data.environments.some((e) => e.id !== input.id && e.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`There is already an environment called "${name}".`);
    }
    const toolIds = input.toolIds.filter((id) => data.tools.some((t) => t.id === id));
    const existing = data.environments.find((e) => e.id === input.id);
    const env: Environment = {
      ...(existing ?? { id: newId(name) }),
      name,
      toolIds,
      projectPath: input.projectPath.trim(),
      notes: input.notes.trim(),
    };
    data.environments = existing ? data.environments.map((e) => (e.id === env.id ? env : e)) : [...data.environments, env];
    this.write(data);
    return env;
  }

  deleteEnvironment(id: string): void {
    const data = this.read();
    if (data.environments.find((e) => e.id === id)?.builtIn === "project") {
      throw new Error("The Project folder environment is built in and cannot be deleted.");
    }
    data.environments = data.environments.filter((e) => e.id !== id);
    this.write(data);
  }

  resolve(environmentId: string): { env: Environment; studio: McpServer | null; servers: McpServers; all: McpServers } {
    const data = this.read();
    const env = data.environments.find((e) => e.id === environmentId);
    if (!env) throw new Error("That environment no longer exists. Pick another one.");
    const used = new Set<string>();
    const unique = (name: string) => {
      let key = safeServerName(name);
      for (let n = 2; used.has(key.toLowerCase()); n++) key = `${safeServerName(name)}_${n}`;
      used.add(key.toLowerCase());
      return key;
    };
    let studio: McpServer | null = null;
    const servers: McpServers = {};
    const all: McpServers = {};
    for (const toolId of env.toolIds) {
      const tool = data.tools.find((t) => t.id === toolId);
      if (!tool) continue;
      if (tool.builtIn === "roblox-studio") {
        studio = tool.server;
        all.Roblox_Studio = tool.server;
        used.add("roblox_studio");
        continue;
      }
      const key = unique(tool.name);
      servers[key] = tool.server;
      all[key] = tool.server;
    }
    return { env, studio, servers, all };
  }
}
