import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import path from "node:path";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { loadConfig } from "../../src/config.ts";
import { checkTools } from "../../src/check.ts";
import { modelCatalog } from "../../src/models.ts";
import { RunManager } from "./runs.ts";
import { IPC, type AgentLoopApi, type ApiMethod, type AppEvent } from "../shared/api.ts";

const root = app.getAppPath();
const dataDir = app.isPackaged ? app.getPath("userData") : root;
let window: BrowserWindow | null = null;
let quitting = false;

const send = (event: AppEvent) => {
  if (window && !window.isDestroyed()) window.webContents.send(IPC.event, event);
};

function configFile(): string {
  if (process.env.AGENTLOOP_CONFIG) return process.env.AGENTLOOP_CONFIG;
  const file = path.join(dataDir, "agentloop.config.json");
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(path.join(root, "agentloop.config.json"), file);
  }
  return file;
}

const config = loadConfig(root, configFile(), dataDir);
const runs = new RunManager(config, send);
runs.sweepFinishedFolders();

type Handlers = { [K in ApiMethod]: (...args: Parameters<AgentLoopApi[K]>) => unknown };

const handlers: Handlers = {
  info: () => ({
    judgeModel: config.agents.judge.model,
    robloxGuides: config.roblox.guides,
    folderGuides: config.folder.guides,
  }),
  listRuns: () => runs.list(),
  getRun: (id) => runs.get(id),
  startRun: (request) => runs.start(request),
  resumeRun: (id) => runs.resume(id),
  stopRun: (id) => runs.stop(id),
  answerPause: (id, yes) => runs.answer(id, yes),
  deleteRun: (id) => runs.delete(id),
  readDiff: (id, round, which) => runs.readDiff(id, round, which),
  finishAction: (id, action) => runs.finishAction(id, action),
  pickFolder: async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  },
  pickFiles: async () => {
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Guides", extensions: ["md", "txt"] }, { name: "All files", extensions: ["*"] }],
    });
    return result.canceled ? [] : result.filePaths;
  },
  checkTools: () => checkTools(config),
  listModels: (refresh) => modelCatalog(config, Boolean(refresh)),
};

ipcMain.handle(IPC.invoke, async (_event, method: ApiMethod, args: unknown[]) => {
  const handler = handlers[method] as ((...a: unknown[]) => unknown) | undefined;
  if (!handler) throw new Error(`Unknown action: ${method}`);
  return handler(...args);
});

function createWindow(): void {
  nativeTheme.themeSource = "dark";
  window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: "Agent Loop",
    backgroundColor: "#00000000",
    backgroundMaterial: "acrylic",
    icon: path.join(root, "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, "dist", "app", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("close", (event) => {
    if (quitting || !runs.hasLiveRuns) return;
    const choice = dialog.showMessageBoxSync(window!, {
      type: "warning",
      buttons: ["Stop runs and quit", "Keep running"],
      defaultId: 1,
      cancelId: 1,
      message: "Runs are still going.",
      detail: "Quitting stops them. You can resume them later from the run list.",
    });
    if (choice !== 0) {
      event.preventDefault();
      return;
    }
    quitting = true;
    runs.stopAll();
  });

  if (process.env.AGENTLOOP_SMOKE) {
    window.webContents.on("did-finish-load", async () => {
      const result = await window!.webContents.executeJavaScript(
        process.env.AGENTLOOP_SMOKE_RUN
          ? `(async () => {
              const api = window.agentLoop;
              const events = [];
              api.onEvent((e) => events.push(e.type));
              const { id } = await api.startRun(${process.env.AGENTLOOP_SMOKE_RUN});
              let d;
              for (let i = 0; i < 240; i++) {
                await new Promise((r) => setTimeout(r, 500));
                d = await api.getRun(id);
                if (d && !d.live && (d.folderDeleted || i > 230 || d.status !== "clean")) break;
              }
              const listed = (await api.listRuns()).find((r) => r.id === id);
              return { status: d.status, endReason: d.state.endReason, rounds: d.state.rounds.length, decisions: d.state.rounds.map((r) => (r.decisions || []).map((x) => x.id + ":" + x.verdict).join(",")), logLines: d.logs.length, timeline: d.state.timeline.map((t) => t.phase + t.round).join(" "), diffChars: (await api.readDiff(id, 1, "total")).length, folderDeleted: d.folderDeleted, deleteLog: d.logs.filter((l) => /delete/i.test(l.text)).map((l) => l.text), inList: Boolean(listed), events: [...new Set(events)] };
            })()`
          : `(async () => ({ title: document.title, bridge: typeof window.agentLoop, runs: (await window.agentLoop.listRuns()).length, tools: await window.agentLoop.checkTools(), heading: document.querySelector("h1")?.textContent }))()`,
      );
      console.log(`SMOKE ${JSON.stringify(result)}`);
      app.quit();
    });
  }

  const devUrl = process.env.AGENTLOOP_DEV_URL;
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(root, "dist", "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
