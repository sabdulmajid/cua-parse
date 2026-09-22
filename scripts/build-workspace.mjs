import { build } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync, statSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";
import { buildShowcase } from "./build-showcase.mjs";

// Validate and copy only reviewed public assets before compiling the browser app.
const { output } = buildShowcase();
try {
  await build({
    root: path.resolve("showcase"),
    configFile: false,
    envDir: false,
    envPrefix: [],
    publicDir: false,
    base: "./",
    plugins: [
      react(),
      {
        name: "browser-only-publication",
        generateBundle(_options, bundle) {
          for (const item of Object.values(bundle)) {
            if (item.type !== "chunk") continue;
            if (
              item.moduleIds.some((id) =>
                /\/src\/(server|client)\/|\/(?:@elevenlabs|@elastic|openai)\//.test(
                  id,
                ),
              )
            ) {
              throw new Error(
                "The public workspace cannot contain backend or paid-provider modules.",
              );
            }
          }
        },
      },
    ],
    build: {
      outDir: output,
      emptyOutDir: false,
      sourcemap: false,
      modulePreload: { polyfill: false },
    },
  });
  function size(directory) {
    return readdirSync(directory).reduce((total, name) => {
      const file = path.join(directory, name);
      return (
        total +
        (statSync(file).isDirectory() ? size(file) : statSync(file).size)
      );
    }, 0);
  }
  const bytes = size(output);
  if (bytes > 5 * 1024 * 1024)
    throw new Error("The public workspace exceeds its 5 MiB release budget.");
  copyFileSync("deployment/vercel.json", path.join(output, "vercel.json"));
  console.log(
    `Public workspace: ${(bytes / 1024 / 1024).toFixed(2)} MiB; no backend or provider modules.`,
  );
} catch (error) {
  rmSync(output, { recursive: true, force: true });
  throw error;
}
