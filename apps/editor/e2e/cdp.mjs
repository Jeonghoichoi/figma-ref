// Minimal Chrome DevTools Protocol harness for the e2e scripts: launches
// headless Chrome, and exposes evaluate / mouse / keyboard / screenshot helpers.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const META = 4;
export const SHIFT = 8;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODES = { Escape: "Escape", Backspace: "Backspace", ArrowRight: "ArrowRight", Enter: "Enter" };
const VK = { Escape: 27, Backspace: 8, ArrowRight: 39, Enter: 13 };

export async function launch({ out, port = 9333 } = {}) {
  const dir = out ?? mkdtempSync(join(tmpdir(), "figref-e2e-"));
  mkdirSync(dir, { recursive: true });
  const chrome = spawn(process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1600,1000",
    `--user-data-dir=${dir}/chrome-profile`, "about:blank",
  ], { stdio: "ignore" });

  let ws;
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  for (let i = 0; !ws && i < 50; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
      }
    } catch {
      await sleep(200);
    }
  }
  if (!ws) throw new Error("chrome did not start");
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = msg.id && pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
    if (msg.method === "Runtime.exceptionThrown") console.log("PAGE EXCEPTION:", msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") console.log("PAGE ERROR:", msg.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  await send("Page.enable");
  await send("Runtime.enable");

  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expr, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await evaluate(expr).catch(() => false)) return true;
      await sleep(150);
    }
    return false;
  };
  const mouse = (type, x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  const drag = async (x0, y0, x1, y1, modifiers = 0) => {
    await mouse("mouseMoved", x0, y0, { buttons: 0, modifiers });
    await mouse("mousePressed", x0, y0, { modifiers });
    for (let i = 1; i <= 8; i++) await mouse("mouseMoved", x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, { modifiers });
    await mouse("mouseReleased", x1, y1, { modifiers });
    await sleep(60);
  };
  const click = async (x, y, modifiers = 0, clickCount = 1) => {
    await mouse("mouseMoved", x, y, { buttons: 0, modifiers });
    await mouse("mousePressed", x, y, { modifiers, clickCount });
    await mouse("mouseReleased", x, y, { modifiers, clickCount });
    await sleep(60);
  };
  const key = async (k, modifiers = 0) => {
    const single = k.length === 1;
    const code = CODES[k] ?? (single ? `Key${k.toUpperCase()}` : k);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, modifiers, text: single && !modifiers ? k : undefined, windowsVirtualKeyCode: single ? k.toUpperCase().charCodeAt(0) : VK[k] });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers });
    await sleep(60);
  };
  const shot = async (name) => {
    await sleep(150);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${dir}/${name}.png`, Buffer.from(data, "base64"));
  };
  const navigate = (url) => send("Page.navigate", { url });

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const finish = () => {
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${dir}`);
    ws.close();
    chrome.kill();
    process.exit(failed ? 1 : 0);
  };

  return { send, evaluate, waitFor, drag, click, key, shot, navigate, check, finish, insertText: (text) => send("Input.insertText", { text }) };
}
