import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { StudioClient } from "./client.ts";
import { ensureRepo, commitAll } from "../git.ts";

const START_BUDGET_BYTES = 40_000;
const MIN_BUDGET_BYTES = 4_000;

interface Segment {
  name: string;
  className: string;
  dup: number;
}

interface ScriptEntry {
  segments: Segment[];
  runContext: string;
  source: string;
}

interface Piece {
  index: number;
  segments?: Segment[];
  runContext?: string;
  text: string;
}

interface Batch {
  total: number;
  nextIndex?: number;
  nextOffset?: number;
  pieces: Piece[];
}

export interface ManifestEntry {
  file: string;
  instancePath: Segment[];
  className: string;
  runContext: string;
}

export interface ExportResult {
  mirrorDir: string;
  commit: string;
  changed: boolean;
  scriptCount: number;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function batchCode(services: string[], startIndex: number, startOffset: number, budget: number): string {
  const serviceList = services.map((s) => JSON.stringify(s)).join(", ");
  return `
local http = game:GetService("HttpService")
local scripts = {}
for _, service_name in {${serviceList}} do
	local ok, service = pcall(game.GetService, game, service_name)
	if ok and service then
		for _, d in service:GetDescendants() do
			if d:IsA("LuaSourceContainer") and (d:IsA("Script") or d:IsA("LocalScript") or d:IsA("ModuleScript")) then
				table.insert(scripts, d)
			end
		end
	end
end

local function dup_index(node)
	local parent = node.Parent
	if not parent then return 1 end
	local index, count = 0, 0
	for _, sibling in parent:GetChildren() do
		if sibling.Name == node.Name then
			count += 1
			if sibling == node then index = count end
		end
	end
	return if count > 1 then index else 1
end

local budget = ${budget}
local pieces, used = {}, 0
local i, offset = ${startIndex}, ${startOffset}
while i <= #scripts and used < budget do
	local s = scripts[i]
	local source = s.Source
	local piece = { index = i }
	if offset == 1 then
		local segments = {}
		local node = s
		while node and node ~= game do
			table.insert(segments, 1, { name = node.Name, className = node.ClassName, dup = dup_index(node) })
			node = node.Parent
		end
		piece.segments = segments
		piece.runContext = if s:IsA("LocalScript") then "Client" elseif s:IsA("Script") then s.RunContext.Name else "Module"
		used += 300
	end
	local last = math.min(#source, offset + math.max(budget - used, 1000) - 1)
	while last < #source and last >= offset do
		local b = string.byte(source, last + 1)
		if b < 0x80 or b >= 0xC0 then break end
		last -= 1
	end
	piece.text = string.sub(source, offset, last)
	used += #piece.text
	table.insert(pieces, piece)
	if last >= #source then
		i += 1
		offset = 1
	else
		offset = last + 1
	end
end

return http:JSONEncode({
	total = #scripts,
	nextIndex = if i <= #scripts then i else nil,
	nextOffset = if i <= #scripts then offset else nil,
	pieces = pieces,
})
`;
}

export function safeName(name: string, dup: number): string {
  let out = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, (m) => "_".repeat(m.length));
  if (!out) out = "_";
  if (RESERVED.test(out)) out = `_${out}`;
  return dup > 1 ? `${out}~${dup}` : out;
}

function suffixFor(className: string, runContext: string): string {
  if (className === "ModuleScript") return ".luau";
  if (className === "LocalScript" || runContext === "Client") return ".client.luau";
  return ".server.luau";
}

export function fileForSegments(segments: Segment[], runContext: string): string {
  const dirs = segments.slice(0, -1).map((s) => safeName(s.name, s.dup));
  const last = segments[segments.length - 1];
  return [...dirs, safeName(last.name, last.dup) + suffixFor(last.className, runContext)].join("/");
}

export function instancePathString(segments: Segment[]): string {
  return segments.map((s) => (s.dup > 1 ? `${s.name}[${s.dup}]` : s.name)).join("/");
}

function clearMirror(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

export async function readAllScripts(studio: StudioClient, services: string[]): Promise<ScriptEntry[]> {
  const byIndex = new Map<number, ScriptEntry>();
  let index = 1;
  let offset = 1;
  let budget = START_BUDGET_BYTES;

  for (;;) {
    const text = await studio.runLuau(batchCode(services, index, offset, budget));
    const jsonStart = text.indexOf("{");
    let batch: Batch;
    try {
      if (jsonStart < 0) throw new Error("no JSON");
      batch = JSON.parse(text.slice(jsonStart)) as Batch;
    } catch {
      if (budget <= MIN_BUDGET_BYTES) {
        throw new Error(`Studio export reply could not be read: ${text.slice(0, 300)}`);
      }
      budget = Math.max(MIN_BUDGET_BYTES, Math.floor(budget / 2));
      continue;
    }

    for (const piece of batch.pieces) {
      const existing = byIndex.get(piece.index);
      if (existing) {
        existing.source += piece.text;
      } else {
        if (!piece.segments) throw new Error(`Studio export lost the start of script #${piece.index}`);
        byIndex.set(piece.index, { segments: piece.segments, runContext: piece.runContext ?? "Module", source: piece.text });
      }
    }

    if (batch.nextIndex == null) break;
    if (batch.pieces.length === 0) throw new Error("Studio export made no progress");
    index = batch.nextIndex;
    offset = batch.nextOffset ?? 1;
  }

  return [...byIndex.keys()].sort((a, b) => a - b).map((k) => byIndex.get(k)!);
}

export function mirrorDirFor(config: Config): string {
  return path.join(config.root, "mirror", String(config.studio.placeId ?? "default"));
}

export async function exportPlace(config: Config, message: string): Promise<ExportResult> {
  const mirrorDir = mirrorDirFor(config);
  ensureRepo(mirrorDir);

  const studio = await StudioClient.connect(config);
  let scripts: ScriptEntry[];
  try {
    scripts = await readAllScripts(studio, config.studio.exportServices);
  } finally {
    await studio.close();
  }

  clearMirror(mirrorDir);
  const manifest: ManifestEntry[] = [];
  const taken = new Set<string>();

  for (const script of scripts) {
    let file = fileForSegments(script.segments, script.runContext);
    if (taken.has(file.toLowerCase())) {
      let n = 2;
      while (taken.has(file.replace(/(\.\w+)?\.luau$/, `~case${n}$&`).toLowerCase())) n++;
      file = file.replace(/(\.\w+)?\.luau$/, `~case${n}$&`);
    }
    taken.add(file.toLowerCase());

    const full = path.join(mirrorDir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, script.source, "utf8");
    const last = script.segments[script.segments.length - 1];
    manifest.push({ file, instancePath: script.segments, className: last.className, runContext: script.runContext });
  }

  writeFileSync(path.join(mirrorDir, "_manifest.json"), JSON.stringify(manifest, null, 1), "utf8");
  const { commit, changed } = commitAll(mirrorDir, message);
  return { mirrorDir, commit, changed, scriptCount: scripts.length };
}
