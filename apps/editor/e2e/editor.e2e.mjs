// Browser-driven editor test: real pointer + keyboard input via the Chrome
// DevTools Protocol in headless Chrome.
//
// Needs: `pnpm dev` running, fixtures/sample333.fig, Google Chrome installed.
//   node apps/editor/e2e/editor.e2e.mjs [screenshot-dir]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = process.argv[2] ?? mkdtempSync(join(tmpdir(), "figref-e2e-"));
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, "--window-size=1600,1000",
  `--user-data-dir=${OUT}/chrome-profile`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
          }
          if (msg.method === "Runtime.exceptionThrown") console.log("PAGE EXCEPTION:", msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
          if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") console.log("PAGE ERROR:", msg.params.args.map((a) => a.value ?? a.description).join(" "));
        };
        return;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error("chrome did not start");
}

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
async function drag(x0, y0, x1, y1, modifiers = 0) {
  await mouse("mouseMoved", x0, y0, { buttons: 0, modifiers });
  await mouse("mousePressed", x0, y0, { modifiers });
  for (let i = 1; i <= 8; i++) await mouse("mouseMoved", x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8, { modifiers });
  await mouse("mouseReleased", x1, y1, { modifiers });
  await sleep(60);
}
async function click(x, y, modifiers = 0, clickCount = 1) {
  await mouse("mouseMoved", x, y, { buttons: 0, modifiers });
  await mouse("mousePressed", x, y, { modifiers, clickCount });
  await mouse("mouseReleased", x, y, { modifiers, clickCount });
  await sleep(60);
}
const CODES = { r: "KeyR", t: "KeyT", z: "KeyZ", g: "KeyG", d: "KeyD", v: "KeyV", Escape: "Escape", Backspace: "Backspace", ArrowRight: "ArrowRight" };
async function key(k, modifiers = 0) {
  const code = CODES[k] ?? k;
  const text = k.length === 1 && !modifiers ? k : undefined;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, modifiers, text, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : k === "Escape" ? 27 : k === "Backspace" ? 8 : 39 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers });
  await sleep(60);
}
const META = 4, SHIFT = 8;
async function shot(name) {
  await sleep(150);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const S = `window.__figref.editor`;
const sel = () => evaluate(`[...${S}.selection]`);
const nodeInfo = (id) => evaluate(`(() => { const n = ${S}.node(${JSON.stringify(id)}); const w = ${S}.world(n.id); return { id: n.id, type: n.type, name: n.name, parent: n.parentId, x: Math.round(w.m02), y: Math.round(w.m12), w: Math.round(n.size.x), h: Math.round(n.size.y), text: n.text?.characters }; })()`);

try {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:5173/?open=sample333.fig&node=20:2" });
  for (let i = 0; i < 50 && !(await evaluate("!!window.__figref").catch(() => false)); i++) await sleep(200);
  await sleep(1500);
  await shot("e2e-0-loaded");
  const canvasRect = await evaluate(`(() => { const r = document.querySelector("canvas.viewport").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

  // 1) Rectangle tool: R, drag in an empty part of Frame 5 (lower-left area).
  const cx = canvasRect.x, cy = canvasRect.y;
  await key("r");
  check("R selects the rectangle tool", (await evaluate(`${S}.tool`)) === "rectangle");
  await drag(cx + 200, cy + 600, cx + 320, cy + 680);
  let [rect] = await sel();
  let info = await nodeInfo(rect);
  check("drag creates a rectangle inside Frame 5", info.type === "ROUNDED_RECTANGLE" && info.parent === "20:2", JSON.stringify(info));
  check("tool returns to select after creating", (await evaluate(`${S}.tool`)) === "select");
  await shot("e2e-1-created");

  // 2) Move it by dragging its center.
  const before = info;
  await drag(cx + 260, cy + 640, cx + 360, cy + 640);
  info = await nodeInfo(rect);
  check("dragging moves the rectangle right", info.x > before.x && info.y === before.y, `${before.x} → ${info.x}`);

  // 3) Resize from the SE handle: created at screen (200,600)-(320,680), then moved +100 px.
  const box = { x0: cx + 200 + 100, y0: cy + 600, x1: cx + 320 + 100, y1: cy + 680 };
  await drag(box.x1, box.y1, box.x1 + 60, box.y1 + 40);
  const resized = await nodeInfo(rect);
  check("dragging the SE handle enlarges it", resized.w > info.w && resized.h > info.h, `${info.w}×${info.h} → ${resized.w}×${resized.h}`);

  // 4) Undo the resize, redo it.
  await key("z", META);
  const undone = await nodeInfo(rect);
  check("⌘Z undoes the resize", undone.w === info.w && undone.h === info.h, `${undone.w}×${undone.h}`);
  await key("z", META | SHIFT);
  check("⇧⌘Z redoes it", (await nodeInfo(rect)).w === resized.w);

  // 5) Text tool: T, click, type, Escape.
  await key("t");
  await click(cx + 700, cy + 700);
  await sleep(100);
  const hasOverlay = await evaluate(`!!document.querySelector("textarea.text-overlay")`);
  check("text tool opens an inline editor", hasOverlay);
  await send("Input.insertText", { text: "안녕 figref" });
  await shot("e2e-2-typing");
  await key("Escape");
  const [textId] = await sel();
  info = await nodeInfo(textId);
  check("typed text is saved to a TEXT node", info.type === "TEXT" && info.text === "안녕 figref", JSON.stringify(info));
  check("text box auto-sizes to its content", info.w > 50 && info.h > 10, `${info.w}×${info.h}`);
  await shot("e2e-3-text");

  // 6) Select rect + text with shift-click, group them.
  await click(cx + 330, cy + 640);
  await click(cx + 705, cy + 703, SHIFT);
  const two = await sel();
  check("shift-click adds to the selection", two.length === 2, JSON.stringify(two));
  await key("g", META);
  const [group] = await sel();
  info = await nodeInfo(group);
  check("⌘G groups the selection", info.type === "GROUP" && info.parent === "20:2", JSON.stringify(info));

  // 7) Duplicate and delete.
  await key("d", META);
  const [dup] = await sel();
  check("⌘D duplicates the group", dup !== group && (await nodeInfo(dup)).type === "GROUP");
  await key("Backspace");
  check("⌫ deletes the duplicate", !(await evaluate(`${S}.doc.nodes.has(${JSON.stringify(dup)})`)));

  // 8) Arrow nudge with shift.
  await click(cx + 330, cy + 640);
  const g0 = await nodeInfo((await sel())[0]);
  await key("ArrowRight", SHIFT);
  const g1 = await nodeInfo((await sel())[0]);
  check("⇧→ nudges 10px", g1.x - g0.x === 10, `${g0.x} → ${g1.x}`);

  // 9) Save → reopen keeps everything.
  const rt = await evaluate(`(() => { const r = window.__figref.roundtrip(); const g = r.doc.nodes.get(${JSON.stringify(group)}); const kids = [...r.doc.nodes.values()].filter((n) => n.parentId === g?.id); return { bytes: r.bytes, group: g?.type, kids: kids.map((k) => k.type + ":" + (k.text?.characters ?? k.name)).sort() }; })()`);
  check("save + reopen keeps the group and its children", rt.group === "GROUP" && rt.kids.length === 2, JSON.stringify(rt));

  await shot("e2e-4-final");
} catch (e) {
  console.log("ERROR", e.stack ?? e);
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${OUT}`);
  ws?.close();
  chrome.kill();
  process.exit(failed ? 1 : 0);
}
