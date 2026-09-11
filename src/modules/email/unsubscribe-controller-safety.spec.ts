/**
 * `GET /notifications/unsubscribe/:token` used to perform the mutation.
 *
 * A GET on that URL is issued by things that are not the recipient — corporate
 * link scanners (Microsoft Safe Links, gateway URL rewriting), mail previewers and
 * browser prefetch all fetch every link in an incoming message. So the security
 * appliance, not the person, decided they were unsubscribed, before the mail was
 * even opened. RFC 8058 exists precisely because of this: a compliant client POSTs
 * `List-Unsubscribe=One-Click`, and the header this product sends declares that.
 *
 * These run without a database: the point is which HTTP verb reaches the write.
 */
jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { HttpException } from "@nestjs/common";
import type { Request } from "express";
import type { Db } from "../../db/drizzle.module";
import type { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { UnsubscribeController } from "./unsubscribe.controller";
import { createUnsubscribeToken } from "./unsubscribe-token";

const runInNewTenantTransactionMock = jest.mocked(runInNewTenantTransaction);

const SUBJECT = {
  userId: "user-1",
  orgId: "org-1",
  email: "person@example.com",
  scope: "ALL_NON_MANDATORY" as const,
  scopeKey: "",
};

describe("one-click unsubscribe — only POST mutates", () => {
  const db = {} as Db;
  const allowed = { check: jest.fn().mockResolvedValue({ allowed: true }) } as unknown as RateLimitService;
  const req = { ip: "203.0.113.7" } as Request;
  let token: string;

  beforeAll(() => {
    process.env.UNSUBSCRIBE_TOKEN_SECRET = "x".repeat(48);
    const minted = createUnsubscribeToken(SUBJECT);
    if (!minted) throw new Error("token secret not honoured");
    token = minted;
  });

  beforeEach(() => {
    runInNewTenantTransactionMock.mockReset();
    runInNewTenantTransactionMock.mockResolvedValue({
      scopeType: "all",
      scopeKey: "*",
      created: true,
    });
  });

  it("GET reports the scope and writes nothing", async () => {
    const controller = new UnsubscribeController(db, allowed);

    const result = await controller.get(token, req);

    expect(runInNewTenantTransactionMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      applied: false,
      scope: "ALL_NON_MANDATORY",
      message: "Confirm to stop receiving these emails.",
    });
  });

  it("POST applies it, inside a tenant transaction opened from the token's own org", async () => {
    const controller = new UnsubscribeController(db, allowed);

    const result = await controller.post(token, req);

    expect(runInNewTenantTransactionMock).toHaveBeenCalledTimes(1);
    expect(runInNewTenantTransactionMock.mock.calls[0]?.[1]).toBe("org-1");
    expect(result).toMatchObject({ ok: true, applied: true, scope: "ALL_NON_MANDATORY" });
  });

  it("a repeat POST says so rather than claiming a second unsubscribe", async () => {
    runInNewTenantTransactionMock.mockResolvedValue({ scopeType: "all", scopeKey: "*", created: false });
    const controller = new UnsubscribeController(db, allowed);

    const result = await controller.post(token, req);

    expect(result).toMatchObject({
      applied: true,
      message: "You are already unsubscribed from these emails.",
    });
  });

  it("a tampered token writes nothing on either verb, and does not say why", async () => {
    const controller = new UnsubscribeController(db, allowed);
    const tampered = `${token.slice(0, -2)}xy`;

    const viaGet = await controller.get(tampered, req);
    const viaPost = await controller.post(tampered, req);

    expect(runInNewTenantTransactionMock).not.toHaveBeenCalled();
    expect(viaGet).toEqual(viaPost);
    expect(viaGet).toEqual({
      ok: false,
      applied: false,
      message: "This unsubscribe link is invalid or has expired.",
    });
  });

  it("an expired token writes nothing — a link lives in a mail archive forever", async () => {
    const stale = createUnsubscribeToken(SUBJECT, Date.now() - 40 * 24 * 3600 * 1000);
    const controller = new UnsubscribeController(db, allowed);

    const result = await controller.post(stale as string, req);

    expect(runInNewTenantTransactionMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, applied: false });
  });

  it("the rate limiter still short-circuits before the token is even read", async () => {
    const blocked = {
      check: jest.fn().mockResolvedValue({ allowed: false }),
    } as unknown as RateLimitService;
    const controller = new UnsubscribeController(db, blocked);

    await expect(controller.post(token, req)).rejects.toBeInstanceOf(HttpException);
    expect(runInNewTenantTransactionMock).not.toHaveBeenCalled();
  });
});
