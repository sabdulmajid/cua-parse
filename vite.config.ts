import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync } from "node:fs";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      react(),
      {
        name: "workspace-media",
        closeBundle() {
          if (existsSync("showcase/assets"))
            cpSync("showcase/assets", "dist/demo-media", { recursive: true });
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: Number(env.VITE_PORT || 5173),
      strictPort: true,
      proxy: { "/api": env.APP_BASE_URL || "http://127.0.0.1:3000" },
    },
    build: { outDir: "dist" },
  };
});
