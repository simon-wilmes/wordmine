import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gameName = process.env.VITE_GAME_NAME || "cluey";
const gameBase = `/${gameName}`;

function redirectBaseWithoutTrailingSlash(req, res, next) {
  if (!req.url) {
    next();
    return;
  }

  const [pathname, query = ""] = req.url.split("?");
  if (pathname !== gameBase) {
    next();
    return;
  }

  const suffix = query ? `?${query}` : "";
  res.statusCode = 301;
  res.setHeader("Location", `${gameBase}/${suffix}`);
  res.end();
}

const baseRedirectPlugin = {
  name: "base-redirect-plugin",
  configureServer(server) {
    server.middlewares.use(redirectBaseWithoutTrailingSlash);
  },
  configurePreviewServer(server) {
    server.middlewares.use(redirectBaseWithoutTrailingSlash);
  }
};

export default defineConfig({
  base: `${gameBase}/`,
  plugins: [react(), baseRedirectPlugin],
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
