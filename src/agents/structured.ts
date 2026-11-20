import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { codexMcpArgs, type McpServers } from "../mcp.ts";
import { antigravityModelId } from "../models.ts";
import { runProcess } from "../proc.ts";
import { PROVIDER_NAMES, type Role } from "../roles.ts";
import type { BuilderSetup } from "../workspace/types.ts";
import { AgentError, extractJson, failure, type StepContext } from "./types.ts";

interface Request<T> {
  role: Role;
  label: string;
  schema: string;
  key: string;
  validate: (value: T) => void;
  taskOnly?: boolean;
  servers?: McpServers;
  builder?: BuilderSetup;
}

function antigravityArgs<T>(
  ctx: StepContext, schema: string, { role, servers = {}, builder, taskOnly }: Request<T>,
): string[] {
  const agent = ctx.config.agents[role];
  const configDir = path.join(ctx.roundDir, role);
  const agentsDir = path.join(configDir, ".agents");
  mkdirSync(agentsDir, { recursive: true });
  const mcpServers = Object.fromEntries(Object.entries(servers).map(([name, server]) => [
    name, "url" in server ? { serverUrl: server.url, headers: server.headers } : server,
  ]));
  writeFileSync(path.join(agentsDir, "mcp_config.json"), JSON.stringify({ mcpServers }), { mode: 0o600 });
  const edits = builder?.allowedTools.some((tool) => tool === "Edit" || tool === "Write");
  const shell = builder?.allowedTools.some((tool) => tool === "Bash" || tool === "PowerShell");
  const deny = [...(edits ? [] : ["write_file(*)"]), ...(shell ? [] : ["command(*)"])];
  if (taskOnly) deny.push("read_file(*)");
  const allow = builder ? Object.keys(servers).map((name) => `mcp(${name}/*)`) : [];
  if (!Object.keys(servers).length) deny.push("mcp(*)");
  const settings = path.join(configDir, "settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { allow, deny } }));
  const dirs = new Set([ctx.workDir, configDir, ...ctx.guides.map((g) => path.dirname(g)), ...(builder?.addDirs ?? [])]);
  return [
    // agy enters print mode from piped stdin. An explicit --print takes its prompt from argv.
    "--output-format", "json", "--json-schema", schema, "--settings", settings,
    "--mode", builder ? "accept-edits" : "plan",
    ...Array.from(dirs).flatMap((dir) => ["--add-dir", dir]),
    ...(agent.model ? ["--model", antigravityModelId(agent.model, agent.effort)] : []),
  ];
}

export async function askStructured<T>(ctx: StepContext, prompt: string, request: Request<T>): Promise<T> {
  const { role, label, servers = {}, builder, taskOnly } = request;
  const agent = ctx.config.agents[role];
  const name = `${PROVIDER_NAMES[agent.provider]} (${role})`;
  const schema = path.join(ctx.config.root, "schemas", request.schema);
  const logFile = path.join(ctx.roundDir, `${label}.log`);
  const rawFile = path.join(ctx.roundDir, `${label}-raw.json`);
  writeFileSync(path.join(ctx.roundDir, `${label}-prompt.md`), prompt);

  let args: string[];
  switch (agent.provider) {
    case "codex": {
      const writable = builder?.allowedTools.some((tool) => tool === "Write" || tool === "Edit");
      args = [
        "exec", "--sandbox", writable ? "workspace-write" : "read-only", "--skip-git-repo-check",
        "--ephemeral", "--color", "never", "--output-schema", schema, "-o", rawFile,
        "-C", ctx.workDir, ...codexMcpArgs(servers),
        ...(taskOnly ? ["-c", "features.shell_tool=false", "-c", "features.multi_agent=false", "-c", "mcp_servers={}", "-c", 'web_search="disabled"'] : []),
        ...(agent.model ? ["-m", agent.model] : []),
        ...(agent.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(agent.effort)}`] : []),
        "-",
      ];
      break;
    }
    case "claude": {
      const configFile = path.join(ctx.roundDir, `${role}-mcp.json`);
      writeFileSync(configFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
      args = [
        "-p", "--no-session-persistence", "--output-format", "json",
        "--json-schema", JSON.stringify(JSON.parse(readFileSync(schema, "utf8"))), "--permission-mode", "dontAsk",
        "--tools", taskOnly ? "" : "Read,Grep,Glob", "--allowedTools", "StructuredOutput",
        ...(taskOnly ? [] : ["Read", "Grep", "Glob"]),
        ...Object.keys(servers).map((server) => `mcp__${server}`),
        "--strict-mcp-config", "--mcp-config", configFile,
        ...[...new Set(ctx.guides.map((g) => path.dirname(g)))].flatMap((dir) => ["--add-dir", dir]),
        ...(agent.model ? ["--model", agent.model] : []), ...(agent.effort ? ["--effort", agent.effort] : []),
      ];
      break;
    }
    case "antigravity":
      args = antigravityArgs(ctx, schema, request);
      break;
  }

  for (let attempt = 0; ; attempt++) {
    rmSync(rawFile, { force: true });
    const result = await runProcess({
      command: agent.command, args, cwd: ctx.workDir, stdin: prompt, logFile,
      hideArgs: agent.provider === "codex" && Object.keys(servers).length > 0,
      timeoutMs: ctx.config.limits.agentTimeoutMinutes * 60_000, signal: ctx.signal, onLine: ctx.onLine,
    });
    if (result.aborted) throw new AgentError(name, "stopped", logFile);
    if (result.timedOut) throw new AgentError(name, "timed out", logFile);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) throw failure(name, `exited with code ${result.code}`, logFile, output);
    if (agent.provider !== "codex") writeFileSync(rawFile, result.stdout);
    if (!existsSync(rawFile)) throw failure(name, "wrote no final message", logFile, output);
    try {
      const answer = extractJson<T>(readFileSync(rawFile, "utf8"), request.key);
      request.validate(answer);
      return answer;
    } catch (err) {
      const error = failure(name, `could not read its answer: ${(err as Error).message}`, logFile, output);
      const denied = /"denied_actions"\s*:\s*\[\s*\{/.test(output);
      if (error.limit || role === "builder" || agent.provider !== "antigravity" || !denied || attempt > 0) throw error;
      prompt += taskOnly
        ? "\nChoose the starting step using only the request text and return the requested JSON."
        : "\nYour previous attempt used a blocked tool. Inspect files with read-only tools and return the requested JSON.";
    }
  }
}
