import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { TurnstileService } from "./turnstile.service";

async function build(config: Partial<AppConfig>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      TurnstileService,
      { provide: APP_CONFIG, useValue: config },
    ],
  }).compile();
  return moduleRef.get(TurnstileService);
}

const VALID_SECRET = "test-turnstile-secret";

function mockFetchSuccess(): void {
  jest.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ success: true }), { status: 200 }),
  );
}

function mockFetchFailure(): void {
  jest.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ success: false }), { status: 200 }),
  );
}

function mockFetchNetworkError(): void {
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("network error"));
}

function mockFetchNonOk(): void {
  jest.spyOn(global, "fetch").mockResolvedValue(
    new Response("Internal Server Error", { status: 500 }),
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("TurnstileService — absent secret", () => {
  it("PRODUCTION + no secret → throws ServiceUnavailableException (fail closed)", async () => {
    const service = await build({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: undefined });
    await expect(service.verify("any-token", "1.2.3.4")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("PRODUCTION + empty string secret → throws ServiceUnavailableException (fail closed)", async () => {
    const service = await build({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: "   " });
    await expect(service.verify("any-token", "1.2.3.4")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("development + no secret → throws ServiceUnavailableException (fail closed, not only production)", async () => {
    const service = await build({ NODE_ENV: "development", TURNSTILE_SECRET_KEY: undefined });
    await expect(service.verify("any-token", "1.2.3.4")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("test + no secret → throws ServiceUnavailableException (fail closed regardless of NODE_ENV)", async () => {
    const service = await build({ NODE_ENV: "test", TURNSTILE_SECRET_KEY: undefined });
    await expect(service.verify(undefined, undefined)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe("TurnstileService — secret present, token validation", () => {
  it("absent token → throws BadRequestException", async () => {
    const service = await build({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: VALID_SECRET });
    await expect(service.verify(undefined, "1.2.3.4")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("empty-string token → throws BadRequestException", async () => {
    const service = await build({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: VALID_SECRET });
    await expect(service.verify("", "1.2.3.4")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("valid token accepted by Cloudflare → resolves", async () => {
    const service = await build({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: VALID_SECRET });
    mockFetchSuccess();
    await expect(service.verify("good-token", "1.2.3.4")).resolves.toBeUndefined();
  });

  it("Cloudflare returns success:false → throws BadRequestException (bot rejected)", async () => {
    const service = await build({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: VALID_SECRET });
    mockFetchFailure();
    await expect(service.verify("bad-token", "1.2.3.4")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("Cloudflare returns non-2xx → throws ServiceUnavailableException", async () => {
    const service = await build({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: VALID_SECRET });
    mockFetchNonOk();
    await expect(service.verify("any-token", "1.2.3.4")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("fetch throws (network error) → throws ServiceUnavailableException", async () => {
    const service = await build({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: VALID_SECRET });
    mockFetchNetworkError();
    await expect(service.verify("any-token", "1.2.3.4")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("clientIp is optional — succeeds without it", async () => {
    const service = await build({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: VALID_SECRET });
    mockFetchSuccess();
    await expect(service.verify("good-token", undefined)).resolves.toBeUndefined();
  });
});
