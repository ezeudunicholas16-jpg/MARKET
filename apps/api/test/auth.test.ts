import { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

describe("API role auth", () => {
  let app: FastifyInstance | undefined;
  const previous = {
    API_AUTH_REQUIRED: process.env.API_AUTH_REQUIRED,
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN,
    ANALYST_API_TOKEN: process.env.ANALYST_API_TOKEN,
    VIEWER_API_TOKEN: process.env.VIEWER_API_TOKEN
  };

  afterEach(async () => {
    await app?.close();
    app = undefined;
    restoreEnv("API_AUTH_REQUIRED", previous.API_AUTH_REQUIRED);
    restoreEnv("ADMIN_API_TOKEN", previous.ADMIN_API_TOKEN);
    restoreEnv("ANALYST_API_TOKEN", previous.ANALYST_API_TOKEN);
    restoreEnv("VIEWER_API_TOKEN", previous.VIEWER_API_TOKEN);
  });

  it("requires a token when API auth is enabled", async () => {
    process.env.API_AUTH_REQUIRED = "true";
    process.env.VIEWER_API_TOKEN = "viewer-token";
    app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/dashboard" });

    expect(response.statusCode).toBe(401);
  });

  it("allows viewer reads and blocks viewer publishing writes", async () => {
    process.env.API_AUTH_REQUIRED = "true";
    process.env.VIEWER_API_TOKEN = "viewer-token";
    app = await buildApp();

    const readResponse = await app.inject({
      method: "GET",
      url: "/movers",
      headers: { authorization: "Bearer viewer-token" }
    });
    const writeResponse = await app.inject({
      method: "POST",
      url: "/publishing/drafts",
      headers: { authorization: "Bearer viewer-token" },
      payload: { symbol: "NVDA", assetClass: "equity" }
    });

    expect(readResponse.statusCode).toBe(200);
    expect(writeResponse.statusCode).toBe(403);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
