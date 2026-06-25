import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { createHash } from "crypto";
import { ApiKeyGuard } from "./api-key.guard";

function ctxWith(headers: Record<string, string>): { ctx: ExecutionContext; req: { headers: Record<string, string>; apiKey?: unknown } } {
  const req: { headers: Record<string, string>; apiKey?: unknown } = { headers };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

function makeDb(row: Record<string, unknown> | undefined) {
  return { query: { apiKeys: { findFirst: jest.fn().mockResolvedValue(row) } }, update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) } as unknown as import("../../db/drizzle.module").Db;
}
const rl = (allowed: boolean) => ({ check: jest.fn().mockResolvedValue({ allowed, retryAfterSecs: 30 }) }) as unknown as import("../ratelimit/rate-limit.service").RateLimitService;

describe("ApiKeyGuard", () => {
  it("401 when X-API-Key header missing", async () => {
    const g = new ApiKeyGuard(makeDb(undefined), rl(true));
    const { ctx } = ctxWith({});
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("401 when key not found / revoked", async () => {
    const g = new ApiKeyGuard(makeDb(undefined), rl(true));
    const { ctx } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("401 when key expired", async () => {
    const row = { id: "k", orgId: "o", scopes: ["leads:write"], expiresAt: new Date(Date.now() - 1000) };
    const g = new ApiKeyGuard(makeDb(row), rl(true));
    const { ctx } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("403 when scopes lack leads:write", async () => {
    const row = { id: "k", orgId: "o", scopes: ["other:read"], expiresAt: null };
    const g = new ApiKeyGuard(makeDb(row), rl(true));
    const { ctx } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows and attaches req.apiKey when valid + scoped", async () => {
    const row = { id: "k", orgId: "o", scopes: ["leads:write"], expiresAt: null };
    const g = new ApiKeyGuard(makeDb(row), rl(true));
    const { ctx, req } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).resolves.toBe(true);
    expect(req.apiKey).toEqual({ id: "k", orgId: "o", scopes: ["leads:write"] });
  });

  it("hashes the raw key with sha256 for lookup", async () => {
    const row = { id: "k", orgId: "o", scopes: ["*"], expiresAt: null };
    const db = makeDb(row);
    const g = new ApiKeyGuard(db, rl(true));
    const { ctx } = ctxWith({ "x-api-key": "secret" });
    await g.canActivate(ctx);
    const expected = createHash("sha256").update("secret").digest("hex");
    const call = (db.query.apiKeys.findFirst as jest.Mock).mock.calls[0][0];
    const seen = new WeakSet<object>();
    const safe = JSON.stringify(call, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    });
    expect(safe).toContain(expected);
  });
});
