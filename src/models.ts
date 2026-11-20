import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CHOICES, type Provider } from "./roles.ts";
import type { Config } from "./config.ts";
import { resolveCommand } from "./proc.ts";

export interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
}

export interface AgentModels {
  models: ModelOption[];
  defaultModel: string;
  defaultEffort: string;
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
      const families = new Map<string, ModelOption>();
      for (const line of stdout.split(/\r?\n/)) {
        const [rawId, rawLabel] = line.trim().split(/\s+(.+)/);
        const id = rawId?.trim();
        if (!id || !rawLabel || id.includes(" ")) continue;
        const { model, effort } = splitAntigravityModel(id);
        const family = families.get(model) ?? { id: model, label: rawLabel.trim().replace(LABEL_EFFORT, ""), efforts: [] };
        if (effort) family.efforts = sortEfforts([...family.efforts, effort]);
        families.set(model, family);
      }
      resolve([...families.values()]);
    });
  });
}

function codexModels(): ModelOption[] {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const cache = path.join(home, "models_cache.json");
  if (!existsSync(cache)) return [];
  try {
    const data = JSON.parse(readFileSync(cache, "utf8")) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        visibility?: string;
        supported_reasoning_levels?: Array<{ effort?: string } | string>;
      }>;
    };
    return (data.models ?? [])
      .filter((m) => m.slug && m.visibility !== "hide")
      .map((m) => ({
        id: m.slug!,
        label: (m.display_name ?? m.slug!).replace(/^(GPT-[\d.]+)-/i, "$1 "),
        efforts: sortEfforts(
          (m.supported_reasoning_levels ?? [])
            .map((level) => (typeof level === "string" ? level : level.effort))
            .filter((e): e is string => Boolean(e)),
        ),
      }));
  } catch {
    return [];
  }
}

function withDefault(models: ModelOption[], fallback: ModelOption): ModelOption[] {
  return models.some((m) => m.id === fallback.id) ? models : [fallback, ...models];
}

let cached: Promise<ModelCatalog> | null = null;

export function modelCatalog(config: Config, refresh = false): Promise<ModelCatalog> {
  if (cached && !refresh) return cached;
  cached = (async () => {
    const d = DEFAULT_CHOICES;
    return {
      antigravity: {
        models: withDefault(await antigravityModels(config.agents.judge.command), {
          id: d.judge.model,
          label: "Gemini 4 Neon",
          efforts: ["low", "medium", "high", "xhigh"],
        }),
        defaultModel: d.judge.model,
        defaultEffort: d.judge.effort,
      },
      claude: { models: CLAUDE_MODELS, defaultModel: d.builder.model, defaultEffort: d.builder.effort },
      codex: {
        models: withDefault(codexModels(), { id: d.reviewer.model, label: "GPT-6.2 Astra", efforts: CLAUDE_EFFORTS }),
        defaultModel: d.reviewer.model,
        defaultEffort: d.reviewer.effort,
      },
    };
  })();
  return cached;
}
