// Browser-driven test of the home screen: samples, recent files, new files from presets,
// autosave and persistence across reloads.
//
// Needs: `pnpm dev` running, fixtures/sample333.fig, Google Chrome installed.
//   node apps/editor/e2e/home.e2e.mjs [screenshot-dir]
import { launch, sleep } from "./cdp.mjs";

const APP = "http://127.0.0.1:5173/";
const b = await launch({ out: process.argv[2] });
const { evaluate, waitFor, drag, key, shot, navigate, check } = b;

const clickText = (selector, text) =>
  evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); el?.click(); return !!el; })()`);
const recentNames = () => evaluate(`[...document.querySelectorAll(".file-card .meta b")].map((e) => e.textContent)`);
const inEditor = () => waitFor(`!!document.querySelector("canvas.viewport") && !!window.__figref`);
const goHome = async () => {
  await evaluate(`document.querySelector(".home-btn").click()`);
  return waitFor(`!!document.querySelector(".home")`);
};

try {
  await navigate(APP);
  await waitFor(`!!document.querySelector(".home")`);
  await sleep(500);
  await shot("home-0-empty");
  check("home shows presets", (await evaluate(`document.querySelectorAll(".preset").length`)) >= 10);
  check("fresh profile has no recent files", (await evaluate(`!!document.querySelector(".empty-state")`)));

  // Samples tab: thumbnails come from the .fig's embedded thumbnail.png.
  await clickText(".home-side nav button", "샘플");
  await waitFor(`document.querySelectorAll(".file-card img").length > 0 && [...document.querySelectorAll(".file-card img")].every((i) => i.complete)`);
  const thumbs = await evaluate(`[...document.querySelectorAll(".file-card img")].filter((i) => i.naturalWidth > 0).length`);
  check("samples list with embedded thumbnails", thumbs >= 1, `${thumbs} thumbnails`);
  await shot("home-1-samples");

  // Open a sample → editor → back home: it appears in recents.
  await clickText(".file-card", "sample333");
  check("opening a sample enters the editor", await inEditor());
  check("URL carries the library file id", /#file=f-/.test(await evaluate("location.hash")));
  await goHome();
  check("the sample now shows in recent files", (await recentNames()).includes("sample333"), JSON.stringify(await recentNames()));

  // New file from the iPhone preset → draw a rectangle → autosave → home.
  await clickText(".preset", "iPhone 16");
  check("preset creates a new file in the editor", await inEditor());
  const frame = await evaluate(`(() => { const n = [...window.__figref.editor.doc.nodes.values()].find((n) => n.type === "FRAME"); return n && { name: n.name, w: n.size.x, h: n.size.y }; })()`);
  check("it contains a 393×852 artboard", frame?.w === 393 && frame?.h === 852, JSON.stringify(frame));
  const canvas = await evaluate(`(() => { const r = document.querySelector("canvas.viewport").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await key("r");
  await drag(canvas.x - 60, canvas.y - 60, canvas.x + 60, canvas.y + 40);
  check("drawing on the artboard works", (await evaluate(`[...window.__figref.editor.selection].map((id) => window.__figref.editor.node(id).parentId)[0]`)) === "1:1");
  check("autosave runs after editing", await waitFor(`document.querySelector(".save-state")?.textContent === "저장됨"`, 8000));
  await shot("home-2-new-file");

  // Rename via the title field.
  await evaluate(`(() => { const i = document.querySelector(".title-input"); i.focus(); i.value = "앱 시안"; i.dispatchEvent(new Event("input", { bubbles: true })); i.blur(); })()`);
  await sleep(300);
  await goHome();
  await sleep(300);
  const names = await recentNames();
  check("recent files list both, newest first", names[0] === "앱 시안" && names.includes("sample333"), JSON.stringify(names));
  check("recent cards show rendered thumbnails", (await evaluate(`[...document.querySelectorAll(".file-card img")].length`)) >= 2);
  await shot("home-3-recents");

  // Reload: the library persists, and reopening restores the edit.
  await navigate(APP);
  await waitFor(`document.querySelectorAll(".file-card").length >= 2`);
  check("recent files persist across reloads", (await recentNames()).includes("앱 시안"));
  await clickText(".file-card", "앱 시안");
  await inEditor();
  const kinds = await evaluate(`[...window.__figref.editor.doc.nodes.values()].map((n) => n.type).sort().join(",")`);
  check("reopened file keeps the drawn rectangle", kinds.includes("ROUNDED_RECTANGLE") && kinds.includes("FRAME"), kinds);
} catch (e) {
  console.log("ERROR", e.stack ?? e);
  check("no errors", false);
} finally {
  b.finish();
}
