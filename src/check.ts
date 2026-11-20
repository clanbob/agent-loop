import { execFile } from "node:child_process";
import type { Config } from "./config.ts";
import { resolveCommand } from "./proc.ts";
import { StudioClient } from "./studio/client.ts";

export interface ToolCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function version(command: string): Promise<string> {
  const exe = resolveCommand(command);
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);
  return new Promise((resolve, reject) => {
    execFile(
      shell ? "cmd.exe" : exe,
      shell ? ["/d", "/c", exe, "--version"] : ["--version"],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim().split(/\r?\n/)[0])),
    );
  });
}

export async function checkTools(config: Config, includeStudio = true): Promise<ToolCheck[]> {
  const tools: Array<[string, string]> = [
    ["Antigravity", config.agents.judge.command],
    ["Claude", config.agents.builder.command],
    ["Codex", config.agents.reviewer.command],
  ];
  const results = await Promise.all(
    tools.map(async ([name, command]) => {
      try {
        return { name, ok: true, detail: await version(command) };
      } catch (err) {
        return { name, ok: false, detail: (err as Error).message.split("\n")[0] };
      }
    }),
  );
  if (includeStudio) {
    try {
      const studio = await StudioClient.connect(config);
      const studios = await studio.listStudios();
      const chosen = studios.find((s) => s.id === studio.studioId);
      await studio.close();
      results.push({ name: "Roblox Studio", ok: true, detail: chosen?.name ?? "connected" });
    } catch (err) {
      results.push({ name: "Roblox Studio", ok: false, detail: (err as Error).message.split("\n")[0] });
    }
  }
  return results;
}
