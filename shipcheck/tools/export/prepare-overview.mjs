// Export-only visibility preparation; no app server or Autodesk credentials required.
// node tools/export/prepare-overview.mjs [--visible] [--smoke]
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
const HERE = path.dirname(fileURLToPath(import.meta.url)),
  ROOT = path.resolve(HERE, "../.."),
  WORK = path.join(HERE, "work"),
  MODEL = path.join(ROOT, "model");
const smoke = process.argv.includes("--smoke"),
  suffix = smoke ? "overview-smoke" : "overview";
const disk = fs.statfsSync(MODEL);
if (disk.bavail * disk.bsize < 3e9)
  throw Error("STOP: at least 3 GB free space required");
fs.mkdirSync(WORK, { recursive: true });
let html = fs.readFileSync(path.join(HERE, "bake-overview.html"), "utf8");
if (smoke) {
  html = html.replace(
    "const renderer=new THREE.WebGLRenderer",
    "source.chunks=source.chunks.slice(0,1);\n const renderer=new THREE.WebGLRenderer",
  );
  html = html.replace(
    "for(let start=0;start<views.length;start+=6)",
    "views.splice(2);for(let start=0;start<views.length;start+=6)",
  );
}
const types = {
  ".js": "text/javascript",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
};
let origin;
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(
        html
          .replaceAll(
            "http://localhost:5173/inspection/model/",
            origin + "model/",
          )
          .replaceAll("http://localhost:5173/inspection/", origin),
      );
    }
    const prefix = u.pathname.startsWith("/model/")
      ? "/model/"
      : u.pathname.startsWith("/node_modules/three/")
        ? "/node_modules/three/"
        : null;
    if (!prefix) {
      res.writeHead(404);
      return res.end();
    }
    const relative = decodeURIComponent(u.pathname.slice(prefix.length));
    if (
      relative.split("/").some((p) => !p || p.startsWith(".")) ||
      relative.includes("\\")
    )
      throw Error("Invalid helper path");
    const base =
        prefix === "/model/" ? MODEL : path.join(ROOT, "node_modules/three"),
      file = path.resolve(base, relative);
    if (
      !file.startsWith(base + path.sep) ||
      !types[path.extname(file)] ||
      !fs.statSync(file).isFile()
    )
      throw Error("Not found");
    res.writeHead(200, { "Content-Type": types[path.extname(file)] });
    fs.createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${server.address().port}/`;
let browser, fd;
try {
  const win = path.join(
    process.env.PROGRAMFILES || "C:/Program Files",
    "Google/Chrome/Application/chrome.exe",
  );
  const executable =
    process.env.CHROME_PATH ||
    (process.platform === "win32" && fs.existsSync(win) ? win : undefined);
  browser = await chromium.launch({
    ...(executable ? { executablePath: executable } : { channel: "chrome" }),
    headless: !process.argv.includes("--visible"),
    args: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  });
  const page = await browser.newPage(),
    bitsFile = path.join(WORK, suffix + "-visible.pending.bin"),
    metaFile = path.join(WORK, suffix + "-visibility.pending.json");
  fd = fs.openSync(bitsFile, "w");
  await page.exposeFunction("saveBakedBits", (offset, text) => {
    const b = Buffer.from(text, "base64");
    fs.writeSync(fd, b, 0, b.length, offset);
  });
  await page.exposeFunction("saveBakedMetadata", (m) =>
    fs.writeFileSync(metaFile, JSON.stringify(m)),
  );
  page.on("console", (m) => {
    if (m.text().startsWith("BAKE VIEW")) console.log(m.text());
  });
  await page.goto(origin);
  await page.waitForFunction(() => !!window.bake, null, {
    polling: 250,
    timeout: 30000,
  });
  const result = await page.evaluate(() => bake());
  fs.closeSync(fd);
  fd = undefined;
  if (fs.statSync(bitsFile).size !== result.bitLength)
    throw Error("Incomplete visibility transfer");
  fs.renameSync(bitsFile, path.join(WORK, suffix + "-visible.bin"));
  fs.renameSync(metaFile, path.join(WORK, suffix + "-visibility.json"));
  await browser.close();
  browser = undefined;
  if (smoke)
    console.log(
      "Overview preparation smoke check passed; model assets unchanged",
    );
  else
    execFileSync(
      process.execPath,
      [
        "--max-old-space-size=4096",
        path.join(HERE, "tile-model.mjs"),
        "--overview",
      ],
      { stdio: "inherit" },
    );
} catch (e) {
  console.error(
    `Overview preparation failed (${e.name}): ${String(e.message).replace(/https?:[^\s)]+/g, "[model host]")}`,
  );
  process.exitCode = 1;
} finally {
  if (fd !== undefined) fs.closeSync(fd);
  await browser?.close();
  await new Promise((r) => server.close(r));
}
