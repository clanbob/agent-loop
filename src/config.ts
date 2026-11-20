import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface AgentConfig {
  command: string;
  model: string | null;
}

export interface Config {
  root: string;
  studio: {
    mcpCommand: string;
    mcpArgs: string[];
    placeId: number | null;
    exportServices: string[];
  };
  agents: {
    judge: AgentConfig;
    builder: AgentConfig;
    reviewer: AgentConfig;
  };
  guides: string[];
  limits: {
    roundsBeforePause: number;
    agentTimeoutMinutes: number;
    repeatedFindingPause: number;
  };
}

export function expandEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

export function loadConfig(root: string): Config {
  const file = path.join(root, "agentloop.config.json");
  if (!existsSync(file)) throw new Error(`Missing config file: ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));

  const agent = (a: AgentConfig): AgentConfig => ({ command: expandEnv(a.command), model: a.model ?? null });

  return {
    root,
    studio: {
      mcpCommand: expandEnv(raw.studio.mcpCommand),
      mcpArgs: raw.studio.mcpArgs.map(expandEnv),
      placeId: raw.studio.placeId ?? null,
      exportServices: raw.studio.exportServices,
    },
    agents: {
      judge: agent(raw.agents.judge),
      builder: agent(raw.agents.builder),
      reviewer: agent(raw.agents.reviewer),
    },
    guides: (raw.guides as string[]).map(expandEnv),
    limits: raw.limits,
  };
}
