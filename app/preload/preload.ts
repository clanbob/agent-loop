import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AgentLoopApi, type ApiMethod, type AppEvent } from "../shared/api.ts";

const call =
  (method: ApiMethod) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(IPC.invoke, method, args);

const methods: ApiMethod[] = [
  "info",
  "listRuns",
  "getRun",
  "startRun",
  "resumeRun",
  "stopRun",
  "answerPause",
  "setReviewVerdict",
  "submitReview",
  "deleteRun",
  "readDiff",
  "finishAction",
  "pickFolder",
  "pickFiles",
  "checkTools",
  "listModels",
  "getSetup",
  "saveTool",
  "deleteTool",
  "saveEnvironment",
  "deleteEnvironment",
  "parseMcp",
  "testMcp",
];

const api = Object.fromEntries(methods.map((m) => [m, call(m)])) as unknown as Omit<AgentLoopApi, "onEvent">;

contextBridge.exposeInMainWorld("agentLoop", {
  ...api,
  onEvent(listener: (event: AppEvent) => void) {
    const handler = (_e: unknown, event: AppEvent) => listener(event);
    ipcRenderer.on(IPC.event, handler);
    return () => ipcRenderer.removeListener(IPC.event, handler);
  },
} satisfies AgentLoopApi);
