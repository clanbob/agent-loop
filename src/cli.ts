import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { loadConfig, type Config } from "./config.ts";
import { exportPlace } from "./studio/exporter.ts";
import { StudioClient } from "./studio/client.ts";
import { resolveCommand } from "./proc.ts";
import { AgentLoop, type PauseRequest } from "./loop.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): { command: string; flags: Map<string, string[]> } {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags };
}

async function check(config: Config): Promise<void> {
  const tools: Array<[string, string, string[]]> = [
    ["Judge (Antigravity)", config.agents.judge.command, ["--version"]],
    ["Builder (Claude)", config.agents.builder.command, ["--version"]],
    ["Reviewer (Codex)", config.agents.reviewer.command, ["--version"]],
  ];
  for (const [label, command, args] of tools) {
    try {
      const exe = resolveCommand(command);
      const shell = /\.(cmd|bat)$/i.test(exe);
      const out = execFileSync(shell ? "cmd.exe" : exe, shell ? ["/d", "/c", exe, ...args] : args, {
        encoding: "utf8",
        timeout: 30_000,
      });
      console.log(`OK    ${label}: ${out.trim().split(/\r?\n/)[0]}`);
    } catch (err) {
      console.log(`FAIL  ${label}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  try {
    const studio = await StudioClient.connect(config);
    const studios = await studio.listStudios();
    const chosen = studios.find((s) => s.id === studio.studioId);
    console.log(`OK    Roblox Studio: ${chosen?.name ?? studio.studioId}`);
    await studio.close();
  } catch (err) {
    console.log(`FAIL  Roblox Studio: ${(err as Error).message}`);
  }
}

async function confirmInTerminal(pause: PauseRequest): Promise<boolean> {
  console.log(`\n=== PAUSED: ${pause.reason}`);
  for (const line of pause.details.slice(0, 30)) console.log(`  ${line}`);
  if (pause.details.length > 30) console.log(`  ...and ${pause.details.length - 30} more`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Continue the loop? [y/N] ");
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

async function run(config: Config, flags: Map<string, string[]>): Promise<void> {
  const taskFile = flags.get("task-file")?.[0];
  const task = taskFile ? readFileSync(taskFile, "utf8") : flags.get("task")?.[0];
  const scope = flags.get("scope") ?? [];
  if (!task) throw new Error('Give the task with --task "..." or --task-file path');
  if (scope.length === 0) throw new Error("Give at least one --scope Studio path, e.g. --scope ServerScriptService/Combat");

  const loop = new AgentLoop(config, { task, scope }, { confirmContinue: confirmInTerminal });
  const verbose = flags.has("verbose");

  loop.on("phase", (phase, round) => console.log(`\n--- ${round ? `round ${round}: ` : ""}${phase}`));
  loop.on("log", (message) => console.log(message));
  loop.on("agentLine", (agent, line) => {
    if (verbose) console.log(`  [${agent}] ${line}`);
  });
  loop.on("round", (r) => {
    console.log(`Round ${r.round}: Codex reported ${r.findings.length} finding(s)`);
    for (const f of r.findings) console.log(`  ${f.id} [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} ${f.issue}`);
  });

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\nStopping after killing the current agent... (Ctrl+C again to force quit)");
    loop.stop();
  });

  console.log(`Run folder: ${loop.runDir}`);
  const state = await loop.run();
  console.log(`\n=== ${state.status.toUpperCase()} after ${state.rounds.length} round(s)`);
  if (state.error) console.log(`Reason: ${state.error}`);
  console.log(`Details: ${loop.runDir}`);
  process.exitCode = state.status === "clean" ? 0 : 1;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const config = loadConfig(ROOT);

  if (command === "check") return check(config);
  if (command === "export") {
    const result = await exportPlace(config, "manual export");
    console.log(
      `Exported ${result.scriptCount} scripts to ${result.mirrorDir} (${result.changed ? "new commit" : "no changes"} ${result.commit.slice(0, 8)})`,
    );
    return;
  }
  if (command === "run") return run(config, flags);

  console.log(`Usage:
  node src/cli.ts check                      check the three CLIs and the Studio connection
  node src/cli.ts export                     export every script in the place to the mirror folder
  node src/cli.ts run --task "..." --scope ServerScriptService/Feature [--scope ...] [--verbose]
  node src/cli.ts run --task-file task.md --scope ...`);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
