import { FastifyServerOptions } from "fastify";

export function createLoggerOptions(): FastifyServerOptions["logger"] {
  return {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "TELEGRAM_BOT_TOKEN",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "TWELVE_DATA_API_KEY",
        "FMP_API_KEY",
        "FINNHUB_API_KEY",
        "FRED_API_KEY",
        "ALPHA_VANTAGE_API_KEY"
      ],
      censor: "[redacted]"
    }
  };
}
