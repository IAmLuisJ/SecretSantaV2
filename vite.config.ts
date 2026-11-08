import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1", port: Number(process.env.SANTA_LOCAL_PORT ?? "5173"), strictPort: true },
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: process.env.SANTA_LOCAL_STATE ? { path: process.env.SANTA_LOCAL_STATE } : true,
      types: { generate: false },
    }),
    reactRouter(),
  ],
});
