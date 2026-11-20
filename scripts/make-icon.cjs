const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const svg = fs.readFileSync(path.join(root, "build", "icon.svg"), "utf8");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function render(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace(
    /width="512" height="512"/,
    `width="${size}" height="${size}"`,
  )}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await new Promise((r) => setTimeout(r, 150));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return image.resize({ width: size, height: size, quality: "best" });
}

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const out = path.join(root, "build");
  const large = await render(1024);
  fs.writeFileSync(path.join(out, "icon.png"), large.resize({ width: 512, height: 512, quality: "best" }).toPNG());
  const pngs = ICO_SIZES.map((size) => ({ size, data: large.resize({ width: size, height: size, quality: "best" }).toPNG() }));
  fs.writeFileSync(path.join(out, "icon.ico"), ico(pngs));
  console.log(`Icon written: build/icon.png (512) and build/icon.ico (${ICO_SIZES.join(", ")})`);
  app.quit();
});
