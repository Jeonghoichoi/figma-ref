import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

/**
 * Dev-only: lists fixtures/*.fig at /__fixtures and serves them at
 * /__fixtures/<name>, so local samples open with one click. Not part of builds.
 */
function fixtures(): Plugin {
  return {
    name: "figref-fixtures",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__fixtures", (req, res) => {
        const name = decodeURIComponent((req.url ?? "/").slice(1));
        if (!name) {
          const files = existsSync(FIXTURES)
            ? readdirSync(FIXTURES).filter((f) => f.endsWith(".fig")).map((f) => ({ name: f, size: statSync(FIXTURES + f).size }))
            : [];
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(files));
          return;
        }
        if (!/^[\w.-]+\.fig$/.test(name) || !existsSync(FIXTURES + name)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(readFileSync(FIXTURES + name));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), fixtures()],
  server: { port: 5173, host: "127.0.0.1" },
});
