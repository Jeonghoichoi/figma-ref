// Re-renders the thumbnail.png of each fixtures/*.fig with the app's renderer
// (e.g. after removing content, so the old thumbnail can't show it).
//
// Needs: `pnpm dev` running, Google Chrome installed.
//   node apps/editor/e2e/sample-thumbnails.mjs sample.fig sample222.fig …
import { readFileSync, writeFileSync } from "node:fs";
import { decodeFig, encodeFig } from "../../../packages/fig-format/src/index.ts";
import { launch, sleep } from "./cdp.mjs";

const names = process.argv.slice(2);
const b = await launch();
try {
  for (const name of names) {
    await b.navigate(`http://127.0.0.1:5173/?open=${encodeURIComponent(name)}`);
    await b.waitFor(`!!window.__figref && window.__figref.open.file.name === ${JSON.stringify(name.replace(/\.fig$/, ""))}`);
    await sleep(1500); // let images decode
    const png = Buffer.from(await b.evaluate("window.__figref.thumbnail()"), "base64");
    const path = new URL(`../../../fixtures/${name}`, import.meta.url);
    const fig = decodeFig(new Uint8Array(readFileSync(path)));
    if (!fig.zip) throw new Error(`${name}: not a ZIP-wrapped .fig`);
    fig.zip.thumbnail = new Uint8Array(png);
    writeFileSync(path, encodeFig(fig));
    b.check(`${name}: thumbnail ${png.length} bytes`, png.length > 0);
  }
} catch (e) {
  console.log("ERROR", e.stack ?? e);
  b.check("no errors", false);
} finally {
  b.finish();
}
