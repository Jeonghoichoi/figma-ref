// Writes fixtures/synthetic.fig so fig-inspect can be exercised before real samples exist.
//   pnpm tsx packages/fig-format/test/make-synthetic.ts
import * as ref from "kiwi-schema";
import { mkdirSync, writeFileSync } from "node:fs";
import { decodeBinarySchema } from "@figref/kiwi";
import { FIG_LIKE_SCHEMA_TEXT, sampleMessage } from "../../kiwi/test/sample-message";
import { encodeFig } from "../src";

const schema = decodeBinarySchema(ref.encodeBinarySchema(ref.parseSchema(FIG_LIKE_SCHEMA_TEXT)));
const bytes = encodeFig({
  magic: "fig-kiwi",
  version: 48,
  schema,
  message: sampleMessage(),
  compression: ["deflate-raw", "deflate-raw"],
  extraChunks: [],
  zip: { meta: { file_name: "Synthetic" }, images: new Map(), other: new Map() },
});
mkdirSync("fixtures", { recursive: true });
writeFileSync("fixtures/synthetic.fig", bytes);
console.log(`fixtures/synthetic.fig (${bytes.length} bytes)`);
