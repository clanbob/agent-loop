import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface AgentConfig {
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
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

export function loadConfig(root: string, configFile?: string, dataDir: string = root): Config {
  const file = configFile ? path.resolve(configFile) : path.join(root, "agentloop.config.json");
  if (!existsSync(file)) throw new Error(`Missing config file: ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));

  const agent = (a: AgentConfig): AgentConfig => ({
    command: expandEnv(a.command),
    model: a.model ?? null,
    effort: a.effort ?? null,
  });
  const folder = raw.folder ?? {};
  const roblox = raw.roblox ?? raw.studio ?? {};

  return {
    root,
    dataDir,
    agents: {
      judge: agent(raw.agents.judge),
      builder: agent(raw.agents.builder),
      reviewer: agent(raw.agents.reviewer),
    },
    folder: {
      guides: (folder.guides ?? []).map(expandEnv),
      builderTools: folder.builderTools ?? ["Read", "Edit", "Write", "Grep", "Glob", "Bash", "PowerShell"],
      testTimeoutMinutes: folder.testTimeoutMinutes ?? 15,
    },
    roblox: {
      mcpCommand: expandEnv(roblox.mcpCommand ?? "cmd.exe"),
      mcpArgs: (roblox.mcpArgs ?? ["/d", "/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"]).map(expandEnv),
      placeId: roblox.placeId ?? null,
      exportServices: roblox.exportServices ?? ["ServerScriptService", "ReplicatedStorage", "StarterPlayer"],
      guides: (roblox.guides ?? raw.guides ?? []).map(expandEnv),
    },
    deleteRunFolder: raw.deleteRunFolder ?? "onClean",
    limits: raw.limits,
  };
}
