import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveCommand } from "./proc.ts";

export type McpServer =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export type McpServers = Record<string, McpServer>;

export interface McpEnvironment {
  id: string;
  name: string;
  servers: McpServers;
  notes: string;
}

export interface ParsedMcp {
  servers: McpServers;
  problems: string[];
}

export interface McpServerTest {
  name: string;
  ok: boolean;
  tools: string[];
  detail: string;
}

const TEST_TIMEOUT_MS = 45_000;

export function safeServerName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "server";
}

function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of line.matchAll(re)) parts.push(m[1] ?? m[2] ?? m[3]);
  return parts;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) out[k] = String(v);
  return Object.keys(out).length > 0 ? out : undefined;
}

function toServer(raw: unknown): McpServer | string {
  if (!raw || typeof raw !== "object") return "is not an object";
  const r = raw as Record<string, unknown>;
  if (typeof r.url === "string" || typeof r.serverUrl === "string") {
    const url = (r.url ?? r.serverUrl) as string;
    const type = r.type === "sse" || r.transport === "sse" || /\/sse\/?$/.test(url) ? "sse" : "http";
    return { type, url, headers: stringRecord(r.headers) };
  }
  if (typeof r.command === "string" && r.command.trim()) {
    const parts = Array.isArray(r.args) ? r.args.map(String) : undefined;
    const [command, ...inline] = parts === undefined && /\s/.test(r.command.trim()) ? splitCommandLine(r.command) : [r.command.trim()];
    return { command, args: [...inline, ...(parts ?? [])], env: stringRecord(r.env) };
  }
  return "needs a \"command\" or a \"url\"";
}

function looksLikeServer(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && ("command" in (value as object) || "url" in (value as object) || "serverUrl" in (value as object)));
}

export function parseMcpText(text: string, fallbackName: string): ParsedMcp {
  const trimmed = text.trim();
  const servers: McpServers = {};
  const problems: string[] = [];
  if (!trimmed) return { servers, problems };

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const words = splitCommandLine(trimmed.replace(/^claude\s+mcp\s+add\s+(\S+)\s+(--\s+)?/i, (_m, name) => {
      fallbackName = name;
      return "";
    }));
    if (words.length === 0) return { servers, problems: ["Nothing to read."] };
    if (/^https?:\/\//i.test(words[0])) servers[safeServerName(fallbackName)] = { type: /\/sse\/?$/.test(words[0]) ? "sse" : "http", url: words[0] };
    else servers[safeServerName(fallbackName)] = { command: words[0], args: words.slice(1) };
    return { servers, problems };
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed.replace(/,\s*([}\]])/g, "$1"));
  } catch (err) {
    return { servers, problems: [`This is not valid JSON: ${(err as Error).message}`] };
  }

  const obj = data as Record<string, unknown>;
  const map =
    (obj?.mcpServers as Record<string, unknown>) ??
    (obj?.servers as Record<string, unknown>) ??
    ((obj?.mcp as Record<string, unknown>)?.servers as Record<string, unknown>) ??
    (looksLikeServer(obj) ? { [fallbackName]: obj } : obj);

  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { servers, problems: ["Could not find any MCP servers in it."] };
  }
  for (const [name, raw] of Object.entries(map)) {
    const server = toServer(raw);
    if (typeof server === "string") problems.push(`"${name}" ${server}.`);
    else servers[safeServerName(name)] = server;
  }
  if (Object.keys(servers).length === 0 && problems.length === 0) problems.push("Could not find any MCP servers in it.");
  return { servers, problems };
}

export function normalizeServers(servers: McpServers): McpServers {
  if (process.platform !== "win32") return servers;
  const out: McpServers = {};
  for (const [name, server] of Object.entries(servers)) {
    if ("url" in server || /^(cmd|cmd\.exe)$/i.test(server.command)) {
      out[name] = server;
      continue;
    }
    let resolved = server.command;
    try {
      resolved = resolveCommand(server.command);
    } catch {}
    out[name] = /\.(cmd|bat)$/i.test(resolved) || /^(npx|npm|pnpm|yarn|bunx|uvx)$/i.test(server.command)
      ? { ...server, command: "cmd", args: ["/c", server.command, ...(server.args ?? [])] }
      : server;
  }
  return out;
}

function transportFor(server: McpServer, sse = false): Transport {
  if ("url" in server) {
    const init = server.headers ? { requestInit: { headers: server.headers } } : undefined;
    return sse || server.type === "sse"
      ? new SSEClientTransport(new URL(server.url), init)
      : new StreamableHTTPClientTransport(new URL(server.url), init);
  }
  return new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
    stderr: "ignore",
  });
}

async function listTools(server: McpServer, sse = false): Promise<string[]> {
  const client = new Client({ name: "agent-loop-test", version: "0.1.0" });
  const transport = transportFor(server, sse);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`no answer within ${TEST_TIMEOUT_MS / 1000} seconds`)), TEST_TIMEOUT_MS),
  );
  try {
    await Promise.race([client.connect(transport), timeout]);
    const result = await Promise.race([client.listTools(), timeout]);
    return result.tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

export async function testServers(servers: McpServers): Promise<McpServerTest[]> {
  return Promise.all(
    Object.entries(servers).map(async ([name, server]) => {
      try {
        const tools = await listTools(server);
        return { name, ok: true, tools, detail: `${tools.length} tool${tools.length === 1 ? "" : "s"}` };
      } catch (err) {
        if ("url" in server && server.type !== "sse") {
          try {
            const tools = await listTools(server, true);
            return { name, ok: true, tools, detail: `${tools.length} tool${tools.length === 1 ? "" : "s"} (SSE)` };
          } catch {}
        }
        const message = (err as Error).message.split("\n")[0];
        const detail =
          "command" in server && /connection closed/i.test(message)
            ? "The server stopped right away. Check the command is installed and correct, and that any keys it needs are set."
            : message;
        return { name, ok: false, tools: [], detail };
      }
    }),
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlTable(record: Record<string, string>): string {
  return `{${Object.entries(record)
    .map(([k, v]) => `${tomlKey(k)}=${tomlString(v)}`)
    .join(",")}}`;
}

export function codexMcpArgs(servers: McpServers): string[] {
  const args: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const key = `mcp_servers.${tomlKey(name)}`;
    if ("url" in server) {
      args.push("-c", `${key}.url=${tomlString(server.url)}`);
      if (server.headers) args.push("-c", `${key}.http_headers=${tomlTable(server.headers)}`);
      continue;
    }
    args.push("-c", `${key}.command=${tomlString(server.command)}`);
    args.push("-c", `${key}.args=[${(server.args ?? []).map(tomlString).join(",")}]`);
    if (server.env) args.push("-c", `${key}.env=${tomlTable(server.env)}`);
  }
  return args;
}

export function describeServer(server: McpServer): string {
  if ("url" in server) return `${server.type === "sse" ? "SSE" : "HTTP"} ${server.url}`;
  const args = server.args ?? [];
  const shown = server.command === "cmd" && args[0] === "/c" ? args.slice(1) : [server.command, ...args];
  return shown.join(" ");
}
