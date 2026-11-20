import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CHOICES, type AgentChoice, type AgentChoices, type Provider, type Role } from "./roles.ts";

export interface AgentConfig {
  provider: Provider;
  command: string;
  model: string | null;
  effort: string | null;
}

export interface Config {
  root: string;
  dataDir: string;
  agents: {
    judge: AgentConfig;
    builder: AgentConfig;
    reviewer: AgentConfig;
  };
  folder: {
    guides: string[];
    builderTools: string[];
    testTimeoutMinutes: number;
  };
  roblox: {
    mcpCommand: string;
    mcpArgs: string[];
    placeId: number | null;
    exportServices: string[];
    guides: string[];
  };
  deleteRunFolder: "onClean" | "always" | "never";
  limits: {
    roundsBeforePause: number;
    agentTimeoutMinutes: number;
    repeatedFindingPause: number;
  };
}

export function expandEnv(value: string): string {
  return value
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, a: string, b: string) => process.env[a ?? b] ?? whole);
}

type PerPlatform<T> = T | { win32?: T; darwin?: T; linux?: T; default?: T };

function forPlatform<T>(value: PerPlatform<T> | undefined, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "object" && !Array.isArray(value)) {
    const table = value as { win32?: T; darwin?: T; linux?: T; default?: T };
    if ("win32" in table || "darwin" in table || "linux" in table || "default" in table) {
      return (table[process.platform as "win32" | "darwin" | "linux"] ?? table.default ?? fallback) as T;
    }
  }
  return value as T;
}

const DEFAULT_ROBLOX_MCP =
  process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"] }
    : { command: "", args: [] as string[] };

export function loadConfig(root: string, configFile?: string, dataDir: string = root): Config {
  const file = configFile ? path.resolve(configFile) : path.join(root, "agentloop.config.json");
  if (!existsSync(file)) throw new Error(`Missing config file: ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));

  const agent = (a: AgentConfig & { command: PerPlatform<string> }, fallback: string, provider: Provider): AgentConfig => ({
    provider,
    command: expandEnv(forPlatform(a?.command, fallback)),
    model: a?.model ?? null,
    effort: a?.effort ?? null,
  });
  const folder = raw.folder ?? {};
  const roblox = raw.roblox ?? raw.studio ?? {};

  return {
    root,
    dataDir,
    agents: {
      judge: agent(raw.agents?.judge, "agy", DEFAULT_CHOICES.judge.provider),
      builder: agent(raw.agents?.builder, "claude", DEFAULT_CHOICES.builder.provider),
      reviewer: agent(raw.agents?.reviewer, "codex", DEFAULT_CHOICES.reviewer.provider),
    },
    folder: {
      guides: forPlatform<string[]>(folder.guides, []).map(expandEnv),
      builderTools: forPlatform<string[]>(folder.builderTools, ["Read", "Edit", "Write", "Grep", "Glob", "Bash", "PowerShell"]),
      testTimeoutMinutes: folder.testTimeoutMinutes ?? 15,
    },
    roblox: {
      mcpCommand: expandEnv(forPlatform<string>(roblox.mcpCommand, DEFAULT_ROBLOX_MCP.command)),
      mcpArgs: forPlatform<string[]>(roblox.mcpArgs, DEFAULT_ROBLOX_MCP.args).map(expandEnv),
      placeId: roblox.placeId ?? null,
      exportServices: roblox.exportServices ?? ["ServerScriptService", "ReplicatedStorage", "StarterPlayer"],
      guides: forPlatform<string[]>(roblox.guides ?? raw.guides, []).map(expandEnv),
    },
    deleteRunFolder: raw.deleteRunFolder ?? "onClean",
    limits: raw.limits,
  };
}

export function withAgentChoices(config: Config, choices: AgentChoices | null | undefined): Config {
  if (!choices) return config;
  const providers = Object.values(config.agents);
  function pick(role: Role, choice?: AgentChoice): AgentConfig {
    if (!choice) return config.agents[role];
    const provider = choice.provider ?? DEFAULT_CHOICES[role].provider;
    const base = providers.find((agent) => agent.provider === provider);
    if (!base) throw new Error(`Unknown provider for ${role}: ${provider}`);
    return { ...base, model: choice.model?.trim() || base.model, effort: choice.effort };
  }
  return {
    ...config,
    agents: {
      judge: pick("judge", choices.judge),
      builder: pick("builder", choices.builder),
      reviewer: pick("reviewer", choices.reviewer),
    },
  };
}
