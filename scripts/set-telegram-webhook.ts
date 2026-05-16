import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnv();

const token = process.env.TELEGRAM_BOT_TOKEN;
const explicitWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
const apiPublicUrl = process.env.API_PUBLIC_URL;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const webhookUrl = explicitWebhookUrl ?? (apiPublicUrl ? `${apiPublicUrl.replace(/\/$/, "")}/webhooks/telegram` : "");

async function main() {
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }
  if (!webhookUrl || !webhookUrl.startsWith("https://")) {
    throw new Error("Set TELEGRAM_WEBHOOK_URL or API_PUBLIC_URL to an HTTPS URL.");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret || undefined,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: process.env.TELEGRAM_DROP_PENDING_UPDATES === "true"
    })
  });
  const payload = (await response.json()) as { ok: boolean; description?: string };
  if (!payload.ok) {
    throw new Error(payload.description ?? "Telegram setWebhook failed.");
  }

  const infoResponse = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const infoPayload = await infoResponse.json();
  console.log(JSON.stringify({ setWebhook: payload, webhookInfo: infoPayload }, null, 2));
}

function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match || process.env[match[1]]) {
      continue;
    }
    process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
