import type { AgentLoopApi } from "../shared/api.ts";
import { createMockApi } from "./mock.ts";

declare global {
  interface Window {
    agentLoop?: AgentLoopApi;
  }
}

export const isMock = !window.agentLoop;
document.documentElement.classList.add(isMock ? "no-glass" : "glass");
export const api: AgentLoopApi = window.agentLoop ?? createMockApi();

export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
