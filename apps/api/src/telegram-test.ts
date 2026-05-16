import "dotenv/config";
import { createServices } from "./app";
import { handleTelegramCommand } from "./commands";
import { parseTelegramCommand } from "@market-desk/telegram";

async function main() {
  const text = process.argv
    .slice(2)
    .filter((arg) => arg !== "--")
    .join(" ") || "/status";
  const parsed = parseTelegramCommand(text);
  if (!parsed) {
    throw new Error("Provide a Telegram-style command, for example: pnpm dev:telegram-test -- /why NVDA");
  }

  const services = createServices();
  const result = await handleTelegramCommand(parsed, {
    pipeline: services.pipeline,
    marketData: services.providers.marketData,
    compliance: services.compliance,
    telegram: services.telegram,
    publishing: services.publishing,
    providerHealth: services.providers.health
  });

  console.log(result.text);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
