import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gameName = process.env.VITE_GAME_NAME || "wordmine";

export default defineConfig({
  base: `/${gameName}/`,
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: true,
    port: 5173,
    proxy: {
      [`/${gameName}/api`]: "http://localhost:3001",
      [`/${gameName}/health`]: "http://localhost:3001",
      [`/${gameName}/socket.io`]: {
        target: "http://localhost:3001",
        ws: true
      }
    }
  }
});
