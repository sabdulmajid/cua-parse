import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: Number(env.VITE_PORT || 5173),
      strictPort: true,
      proxy: { "/api": env.APP_BASE_URL || "http://127.0.0.1:3000" },
    },
    build: { outDir: "dist" },
  };
});
