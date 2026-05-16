import "dotenv/config";
import { buildApp } from "./app";
import { captureException } from "./error-tracking";
import { createLoggerOptions } from "./logger";
import { startScheduler, SchedulerHandle } from "./scheduler";

async function main() {
  const app = await buildApp({ logger: createLoggerOptions() });
  const port = Number(process.env.PORT || 10000);
  const host = "0.0.0.0";
  let scheduler: SchedulerHandle | undefined;

  if (process.env.ENABLE_SCHEDULER === "true" && process.env.REDIS_URL) {
    scheduler = await startScheduler(process.env.REDIS_URL);
    app.log.info("BullMQ scheduler started.");
  }

  const shutdown = async () => {
    await scheduler?.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port, host });
}

main().catch((error) => {
  captureException(error, { source: "server_boot" });
  console.error(error);
  process.exit(1);
});
