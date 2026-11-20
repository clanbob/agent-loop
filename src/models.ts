import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.ts";
import { resolveCommand } from "./proc.ts";

export interface ModelOption {
  id: string;
  label: string;
}

export interface AgentModels {
  models: ModelOption[];
  efforts: string[];
  defaultModel: string | null;
  defaultEffort: string | null;
}

export interface ModelCatalog {
  judge: AgentModels;
  builder: AgentModels;
  reviewer: AgentModels;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const CLAUDE_MODELS: ModelOption[] = [
  { id: "fable", label: "Fable (latest)" },
  { id: "opus", label: "Opus (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
];

function antigravityModels(command: string): Promise<ModelOption[]> {
  return new Promise((resolve) => {
    let exe: string;
    try {
      exe = resolveCommand(command);
    } catch {
      return resolve([]);
    }
    execFile(exe, ["models"], { encoding: "utf8", timeout: 30_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const models = stdout
        .split(/\r?\n/)
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length >= 2 && parts[0].trim() && !parts[0].includes(" "))
        .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
      resolve(models);
    });
  });
}

function codexModels(): { models: ModelOption[]; efforts: string[]; defaultModel: string | null; defaultEffort: string | null } {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const models: ModelOption[] = [];
  const efforts = new Set<string>();
  const cache = path.join(home, "models_cache.json");
  if (existsSync(cache)) {
    try {
      const data = JSON.parse(readFileSync(cache, "utf8")) as {
        models?: Array<{ slug?: string; display_name?: string; visibility?: string; supported_reasoning_levels?: Array<{ effort?: string } | string> }>;
      };
      for (const m of data.models ?? []) {
        if (!m.slug || m.visibility === "hide") continue;
        models.push({ id: m.slug, label: m.display_name ?? m.slug });
        for (const level of m.supported_reasoning_levels ?? []) {
          const effort = typeof level === "string" ? level : level.effort;
          if (effort) efforts.add(effort);
        }
      }
    } catch {}
  }

  let defaultModel: string | null = null;
  let defaultEffort: string | null = null;
  const configFile = path.join(home, "config.toml");
  if (existsSync(configFile)) {
    const toml = readFileSync(configFile, "utf8").split(/\r?\n\[/)[0];
    defaultModel = toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    defaultEffort = toml.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  }

  return { models, efforts: efforts.size > 0 ? [...efforts] : EFFORTS, defaultModel, defaultEffort };
}

let cached: Promise<ModelCatalog> | null = null;

export function modelCatalog(config: Config, refresh = false): Promise<ModelCatalog> {
  if (cached && !refresh) return cached;
  cached = (async () => {
    const codex = codexModels();
    return {
      judge: {
        models: await antigravityModels(config.agents.judge.command),
        efforts: EFFORTS,
        defaultModel: config.agents.judge.model,
        defaultEffort: config.agents.judge.effort,
      },
      builder: {
        models: CLAUDE_MODELS,
        efforts: EFFORTS,
        defaultModel: config.agents.builder.model,
        defaultEffort: config.agents.builder.effort,
      },
      reviewer: {
        models: codex.models,
        efforts: codex.efforts,
        defaultModel: config.agents.reviewer.model ?? codex.defaultModel,
        defaultEffort: config.agents.reviewer.effort ?? codex.defaultEffort,
      },
    };
  })();
  return cached;
}
