import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CHOICES, type Provider, type Role } from "./roles.ts";
import type { Config } from "./config.ts";
import { commandLine, resolveCommand } from "./proc.ts";

export interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
}

export interface AgentModels {
  models: ModelOption[];
  defaultModel: string;
  defaultEffort: string;
  source?: "cli" | "cache" | "suggestions";
}

export type ModelCatalog = Record<Provider, AgentModels>;

export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max|ultra)$/;
const LABEL_EFFORT = /\s*\((low|medium|high|xhigh|max|ultra)\)\s*$/i;

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS: ModelOption[] = [
  { id: "opus", label: "Opus", efforts: CLAUDE_EFFORTS },
  { id: "fable", label: "Fable", efforts: CLAUDE_EFFORTS },
  { id: "sonnet", label: "Sonnet", efforts: CLAUDE_EFFORTS },
  { id: "haiku", label: "Haiku", efforts: CLAUDE_EFFORTS },
];

function sortEfforts(efforts: Iterable<string>): string[] {
  return [...new Set(efforts)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

export function antigravityModelId(model: string, effort: string | null): string {
  if (!effort || EFFORT_SUFFIX.test(model)) return model;
  return `${model}-${effort}`;
}

export function splitAntigravityModel(id: string): { model: string; effort: string | null } {
  const match = id.match(EFFORT_SUFFIX);
  return match ? { model: id.slice(0, -match[0].length), effort: match[1] } : { model: id, effort: null };
}

// This request initializes Claude Code's SDK protocol. It contains no user turn.
const CLAUDE_INITIALIZE = { type: "control_request", request_id: "catalog", request: { subtype: "initialize" } };

async function catalogOutput(command: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const cli = commandLine(resolveCommand(command), args);
    return await new Promise<string>((resolve) => {
      const child = execFile(cli.file, cli.args, {
        env, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
        windowsHide: true, windowsVerbatimArguments: cli.windowsVerbatimArguments,
      }, (err, stdout) => resolve(err ? "" : stdout));
      child.stdin?.on("error", () => {}); // Older CLIs may exit before reading the request.
      child.stdin?.end(input);
    });
  } catch {
    return "";
  }
}

function geminiModels(output: string): ModelOption[] {
  const families = new Map<string, ModelOption>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const { model, effort } = splitAntigravityModel(match[1]);
    const family = families.get(model) ?? { id: model, label: match[2].trim().replace(LABEL_EFFORT, ""), efforts: [] };
    if (effort) family.efforts = sortEfforts([...family.efforts, effort]);
    families.set(model, family);
  }
  return [...families.values()];
}

function claudeModels(output: string): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const line of output.split(/\r?\n/)) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const response = message?.response;
    if (message?.type !== "control_response" || response?.request_id !== CLAUDE_INITIALIZE.request_id ||
        response.subtype !== "success" || !Array.isArray(response.response?.models)) continue;

    for (const model of response.response.models) {
      if (typeof model?.value !== "string" || !model.value) continue;
      const efforts = Array.isArray(model.supportedEffortLevels)
        ? model.supportedEffortLevels.filter((e: unknown) => typeof e === "string")
        : model.supportsEffort ? CLAUDE_EFFORTS : [];
      const id = model.value;
      const label = model.displayName || id;
      models.set(id, { id, label, efforts });
      // The family alias tracks new releases. The resolved ID lets a run pin this version.
      if (typeof model.resolvedModel === "string" && model.resolvedModel && !models.has(model.resolvedModel)) {
        models.set(model.resolvedModel, { id: model.resolvedModel, label: model.resolvedModel, efforts });
      }
    }
  }
  return [...models.values()];
}

function codexModels(output: string): ModelOption[] {
  try {
    const data = JSON.parse(output) as {
      models: Array<{
        slug: string; display_name?: string; visibility?: string;
        supported_reasoning_levels?: Array<{ effort: string } | string>;
      }>;
    };
    return data.models.filter((m) => m.slug && m.visibility !== "hide").map((m) => ({
      id: m.slug,
      label: m.display_name || m.slug,
      efforts: sortEfforts((m.supported_reasoning_levels ?? []).map((e) => typeof e === "string" ? e : e.effort).filter(Boolean)),
    }));
  } catch {
    return [];
  }
}

function cachedCodexModels(): ModelOption[] {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  try {
    return codexModels(readFileSync(path.join(home, "models_cache.json"), "utf8"));
  } catch {
    return [];
  }
}

const FALLBACK: Record<Provider, ModelOption[]> = {
  codex: [
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", efforts: EFFORT_ORDER },
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", efforts: EFFORT_ORDER },
    { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: CLAUDE_EFFORTS },
  ],
  claude: CLAUDE_MODELS,
  antigravity: [
    { id: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
  ],
};

const cached = new WeakMap<Config, Promise<ModelCatalog>>();

export function modelCatalog(config: Config, refresh = false): Promise<ModelCatalog> {
  const previous = cached.get(config);
  if (previous && !refresh) return previous;
  const { judge, builder, reviewer } = config.agents;
  const next = Promise.all([
    catalogOutput(judge.command, ["models"]).then(geminiModels),
    catalogOutput(builder.command, ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--no-session-persistence", "--strict-mcp-config", "--tools", ""],
      JSON.stringify(CLAUDE_INITIALIZE) + "\n", { ...process.env, CLAUDE_CODE_SAFE_MODE: "1" }).then(claudeModels),
    catalogOutput(reviewer.command, ["debug", "models"]).then(codexModels),
    previous,
  ]).then(([gemini, claude, codex, last]) => {
    function group(role: Role, live: ModelOption[]): AgentModels {
      const { provider, model, effort } = config.agents[role];
      let models = live;
      let source: AgentModels["source"] = "cli";
      if (!models.length) {
        models = provider === "codex" ? cachedCodexModels() : [];
        const prior = last?.[provider];
        if (!models.length && prior && prior.source !== "suggestions") models = prior.models;
        source = models.length ? "cache" : "suggestions";
        if (!models.length) models = FALLBACK[provider];
      }
      const preferred = model ?? DEFAULT_CHOICES[role].model;
      const defaultModel = models.some((m) => m.id === preferred) ? preferred : models[0].id;
      return { models, defaultModel, defaultEffort: effort ?? "medium", source };
    }
    return { antigravity: group("judge", gemini), claude: group("builder", claude), codex: group("reviewer", codex) };
  });
  cached.set(config, next);
  return next;
}
