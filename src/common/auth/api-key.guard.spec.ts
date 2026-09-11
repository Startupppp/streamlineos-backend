import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { createHash } from "crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ApiKeyGuard } from "./api-key.guard";
import type { Db } from "../../db/drizzle.module";
import type { RateLimitService } from "../ratelimit/rate-limit.service";
import type { EntitlementsService } from "../../modules/access/entitlements.service";

const dialect = new PgDialect();

function ctxWith(headers: Record<string, string>): { ctx: ExecutionContext; req: { headers: Record<string, string>; apiKey?: unknown } } {
  const req: { headers: Record<string, string>; apiKey?: unknown } = { headers };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as Partial<ExecutionContext> as ExecutionContext;
  return { ctx, req };
}

function makeDb(
  row: Record<string, unknown> | undefined,
  captureWhere?: (where: SQL | undefined) => void,
): Db {
  return {
    query: {
      apiKeys: {
        findFirst: jest.fn((args: { where?: SQL }) => {
          captureWhere?.(args?.where);
          return Promise.resolve(row);
        }),
      },
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as unknown as Db;
}

function makeRl(allowed: boolean): RateLimitService {
  return {
    check: jest.fn().mockResolvedValue({ allowed, retryAfterSecs: 30 }),
  } as Partial<RateLimitService> as RateLimitService;
}

function makeEntitlements(enabled = true): EntitlementsService {
  return {
    isModuleEnabled: jest.fn().mockResolvedValue(enabled),
  } as Partial<EntitlementsService> as EntitlementsService;
}

describe("ApiKeyGuard", () => {
  it("401 when X-API-Key header missing", async () => {
    const g = new ApiKeyGuard(makeDb(undefined), makeRl(true), makeEntitlements());
    const { ctx } = ctxWith({});
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("401 when key not found / revoked", async () => {
    const g = new ApiKeyGuard(makeDb(undefined), makeRl(true), makeEntitlements());
    const { ctx } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("looks up the key by hash AND non-revoked status in the same WHERE", async () => {
    let captured: SQL | undefined;
    const g = new ApiKeyGuard(
      makeDb(undefined, (where) => {
        captured = where;
      }),
      makeRl(true),
      makeEntitlements(),
    );
    const { ctx } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);

    if (!captured) throw new Error("guard did not query with a WHERE clause");
    const { sql: rendered, params } = dialect.sqlToQuery(captured);
    const expectedHash = createHash("sha256").update("raw").digest("hex");
    expect(rendered).toContain("is_revoked");
    expect(params).toContain(false);
    expect(params).toContain(expectedHash);
  });

  it("401 when key expired", async () => {
    const row = { id: "k", orgId: "o", scopes: ["leads:write"], expiresAt: new Date(Date.now() - 1000) };
    const g = new ApiKeyGuard(makeDb(row), makeRl(true), makeEntitlements());
    const { ctx } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("403 when scopes lack leads:write", async () => {
    const row = { id: "k", orgId: "o", scopes: ["other:read"], expiresAt: new Date(Date.now() + 60_000) };
    const g = new ApiKeyGuard(makeDb(row), makeRl(true), makeEntitlements());
    const { ctx } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403 when scopes is empty array", async () => {
    const row = { id: "k", orgId: "o", scopes: [], expiresAt: new Date(Date.now() + 60_000) };
    const g = new ApiKeyGuard(makeDb(row), makeRl(true), makeEntitlements());
    const { ctx } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows and attaches req.apiKey when valid + scoped", async () => {
    const row = { id: "k", orgId: "o", scopes: ["leads:write"], expiresAt: new Date(Date.now() + 60_000) };
    const g = new ApiKeyGuard(makeDb(row), makeRl(true), makeEntitlements());
    const { ctx, req } = ctxWith({ "x-api-key": "raw" });
    await expect(g.canActivate(ctx)).resolves.toBe(true);
    expect(req.apiKey).toEqual({ id: "k", orgId: "o", scopes: ["leads:write"] });
  });

  it("hashes the raw key with sha256 for lookup", async () => {
    const row = { id: "k", orgId: "o", scopes: ["leads:write"], expiresAt: new Date(Date.now() + 60_000) };
    const db = makeDb(row);
    const g = new ApiKeyGuard(db, makeRl(true), makeEntitlements());
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
