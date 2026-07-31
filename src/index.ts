import { loadConfig } from "./config.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);

  app.server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Another pooler instance (e.g. a sibling editor's extension) already
      // owns this host:port — treat it as the running instance and exit
      // quietly instead of crashing with an uncaught exception.
      console.log(
        `[zion-codex-pool] ${config.host}:${config.port} already in use — another instance is likely running, exiting`
      );
      process.exit(0);
    }
    console.error(err);
    process.exit(1);
  });

  app.server.listen(config.port, config.host, () => {
    console.log(
      `[zion-codex-pool] listening on http://${config.host}:${config.port}`
    );
    console.log(`[zion-codex-pool] data dir: ${config.dataDir}`);
    console.log(
      `[zion-codex-pool] accounts: ${app.pool.store.listIds().length}`
    );
    console.log(
      `[zion-codex-pool] Codex base_url → http://${config.host}:${config.port}/backend-api/codex`
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`[zion-codex-pool] ${signal}, shutting down…`);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
