import http from "node:http";
import { WebSocketServer } from "ws";
import { Config } from "./config.js";
import { AccountPool } from "./accounts/pool.js";
import { AccountStore } from "./accounts/store.js";
import { refreshAllQuotas } from "./accounts/quota.js";
import { attachCodexWebSocket } from "./proxy/websocket.js";
import { handleAdmin, handleCodexHttp, handleHealth, sendJson } from "./routes/http.js";

export interface App {
  server: http.Server;
  pool: AccountPool;
  close: () => Promise<void>;
}

export function createApp(config: Config): App {
  const store = new AccountStore(config.dataDir);
  const pool = new AccountPool(store, config.quotaSkipThreshold);

  const server = http.createServer(async (req, res) => {
    try {
      if (handleHealth(req, res, pool)) return;
      if (await handleAdmin(req, res, pool, config.poolApiKey)) return;
      if (await handleCodexHttp(req, res, pool, config.upstreamBase, config.poolApiKey)) return;
      sendJson(res, 404, { error: { message: "Not found" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: msg } });
      } else {
        res.destroy();
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const upstreamWs = config.upstreamBase
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .replace(/\/$/, "");
  // upstreamBase is .../codex → WS endpoint is .../codex/responses
  attachCodexWebSocket(wss, {
    pool,
    upstreamBase: config.upstreamBase,
    upstreamWsUrl: `${upstreamWs}/responses`,
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/backend-api/codex/responses") {
      socket.destroy();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    const token = match?.[1]?.trim() ?? "";
    const keyOk =
      token &&
      (config.poolApiKey === "change-me" || token === config.poolApiKey);
    if (!keyOk) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  let quotaTimer: NodeJS.Timeout | undefined;

  const close = async () => {
    if (quotaTimer) clearInterval(quotaTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    wss.close();
  };

  server.on("listening", () => {
    // Kick off quota poll in background
    void refreshAllQuotas(store).catch((err) => {
      console.warn("[quota] initial refresh failed:", err instanceof Error ? err.message : err);
    });
    quotaTimer = setInterval(() => {
      void refreshAllQuotas(store).catch((err) => {
        console.warn("[quota] refresh failed:", err instanceof Error ? err.message : err);
      });
    }, config.quotaPollMs);
    quotaTimer.unref?.();
  });

  return { server, pool, close };
}
