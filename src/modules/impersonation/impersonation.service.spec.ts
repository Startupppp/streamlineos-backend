import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Redis } from "@upstash/redis";
import { ImpersonationService } from "./impersonation.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../common/auth/principal";

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "actor-uuid",
    orgId: "org-uuid",
    role: "ORG_ADMIN",
    isOrgOwner: false,
    sessionId: "session-uuid",
    tokenScopes: null,
    principal: ACCOUNT_ONLY_PRINCIPAL,
    ...overrides,
  };
}

function buildSelectChain(responses: unknown[]) {
  let callIdx = 0;
  const limitFn = jest.fn().mockImplementation(() => {
    const res = responses[callIdx] ?? [];
    callIdx++;
    return Promise.resolve(res);
  });
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: limitFn,
  };
  const selectFn = jest.fn().mockReturnValue(chain);
  return { selectFn, chain };
}

function buildDb(selectResponses: unknown[][], insertResolves = true) {
  let selectCallIdx = 0;
  const selectFn = jest.fn().mockImplementation(() => {
    const responses = selectResponses[selectCallIdx] ?? [];
    selectCallIdx++;
    let limitCallIdx = 0;
    return {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockImplementation(() => {
        const row = responses[limitCallIdx] ?? undefined;
        limitCallIdx++;
        return Promise.resolve(row !== undefined ? [row] : []);
      }),
    };
  });

  const insertValuesReturn = insertResolves
    ? jest.fn().mockResolvedValue(undefined)
    : jest.fn().mockRejectedValue(new Error("insert failed"));

  const insertFn = jest.fn().mockReturnValue({ values: insertValuesReturn });

  const updateFn = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    }),
  });

  return { select: selectFn, insert: insertFn, update: updateFn };
}

function collectColumnNames(root: unknown): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (typeof record.name === "string" && "columnType" in record)
      found.push(record.name);
    for (const value of Object.values(record)) stack.push(value);
  }
  return found;
}

function captureWhere() {
  const seen: unknown[] = [];
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockImplementation(function whereSpy(this: unknown, condition: unknown) {
        seen.push(condition);
        return this;
      }),
      limit: jest.fn().mockResolvedValue([{ id: "ims-uuid", isRevoked: true }]),
    }),
    insert: jest.fn(),
    update: jest.fn(),
  };
  return { db, columns: () => collectColumnNames(seen) };
}

describe("ImpersonationService", () => {
  let keyring: { signImpersonationToken: jest.Mock };
  let audit: { logCriticalOutsideTransaction: jest.Mock };
  let redis: Pick<Redis, "set"> | null;

  beforeEach(() => {
    keyring = { signImpersonationToken: jest.fn().mockResolvedValue("minted-token") };
    audit = { logCriticalOutsideTransaction: jest.fn().mockResolvedValue(undefined) };
    redis = null;
  });

  function makeService(db: object) {
    const svc = new ImpersonationService(
      db as never,
      redis as never,
      keyring as never,
      audit as never,
    );
    return svc;
  }

  describe("start", () => {
    it("throws BadRequest when actor is already impersonating", async () => {
      const db = buildDb([]);
      const svc = makeService(db);
      const actor = makeActor({
        impersonation: {
          realActorUserId: "someone",
          realSessionId: "s",
          impersonationSessionId: "ims",
        },
      });
      await expect(svc.start(actor, "target-uuid")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws BadRequest when actor impersonates themselves", async () => {
      const db = buildDb([]);
      const svc = makeService(db);
      const actor = makeActor({ userId: "same-uuid" });
      await expect(svc.start(actor, "same-uuid")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws NotFound when target not in org", async () => {
      const db = buildDb([[]]);
      const svc = makeService(db);
      await expect(svc.start(makeActor(), "target-uuid")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws Forbidden when non-owner tries to impersonate org owner", async () => {
      const memberRow = { userId: "target-uuid", role: "OWNER", isOwner: true, status: "ACTIVE" };
      const db = buildDb([[memberRow]]);
      const svc = makeService(db);
      await expect(svc.start(makeActor({ isOrgOwner: false }), "target-uuid")).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("mints token with sub = targetUserId", async () => {
      const memberRow = { userId: "target-uuid", role: "MEMBER", isOwner: false, status: "ACTIVE" };
      const userRow = { id: "target-uuid", name: "T", email: "t@x.com" };
      const db = buildDb([[memberRow], [userRow]]);
      const svc = makeService(db);
      await svc.start(makeActor(), "target-uuid");
      const call = keyring.signImpersonationToken.mock.calls[0][0] as { sub: string };
      expect(call.sub).toBe("target-uuid");
    });

    it("mints token carrying impersonation claims with realActorUserId = actor.userId", async () => {
      const memberRow = { userId: "target-uuid", role: "MEMBER", isOwner: false, status: "ACTIVE" };
      const userRow = { id: "target-uuid", name: "Target", email: "target@example.com" };
      const db = buildDb([[memberRow], [userRow]]);
      const svc = makeService(db);
      const result = await svc.start(makeActor(), "target-uuid");
      expect(result.token).toBe("minted-token");
      expect(keyring.signImpersonationToken).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: "target-uuid",
          impersonation: expect.objectContaining({ realActorUserId: "actor-uuid" }),
        }),
      );
    });

    it("allows org owner to impersonate org owner", async () => {
      const memberRow = { userId: "target-uuid", role: "OWNER", isOwner: true, status: "ACTIVE" };
      const userRow = { id: "target-uuid", name: "Owner", email: "owner@example.com" };
      const db = buildDb([[memberRow], [userRow]]);
      const svc = makeService(db);
      const result = await svc.start(makeActor({ isOrgOwner: true }), "target-uuid");
      expect(result.targetUser.id).toBe("target-uuid");
    });

    it("returns impersonationSessionId in the response", async () => {
      const memberRow = { userId: "target-uuid", role: "MEMBER", isOwner: false, status: "ACTIVE" };
      const userRow = { id: "target-uuid", name: "T", email: "t@x.com" };
      const db = buildDb([[memberRow], [userRow]]);
      const svc = makeService(db);
      const result = await svc.start(makeActor(), "target-uuid");
      expect(typeof result.impersonationSessionId).toBe("string");
      expect(result.impersonationSessionId.length).toBeGreaterThan(0);
    });
  });

  describe("stop", () => {
    it("throws NotFound when impersonation session not found", async () => {
      const db = buildDb([[]]);
      const svc = makeService(db);
      await expect(svc.stop(makeActor(), "ims-uuid")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers another org's impersonation session id with NotFound, so it cannot be used as an existence oracle", async () => {
      const db = buildDb([[]]);
      const svc = makeService(db);
      await expect(svc.stop(makeActor(), "ims-uuid")).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.stop(makeActor(), "ims-uuid")).rejects.not.toBeInstanceOf(ForbiddenException);
    });

    it("filters the lookup on org and actor in SQL, because impersonation_sessions carries no RLS policy", async () => {
      const where = captureWhere();
      const svc = makeService(where.db);
      await svc.stop(makeActor(), "ims-uuid");
      expect(where.columns()).toEqual(
        expect.arrayContaining(["id", "org_id", "actor_user_id"]),
      );
    });

    it("revokes the impersonation session", async () => {
      const sessionRow = { id: "ims-uuid", actorUserId: "actor-uuid", orgId: "org-uuid", isRevoked: false };
      const db = buildDb([[sessionRow]]);
      const svc = makeService(db);
      const result = await svc.stop(makeActor(), "ims-uuid");
      expect(result.success).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });

    it("writes Redis tombstone when Redis is available", async () => {
      redis = { set: jest.fn().mockResolvedValue("OK") };
      const sessionRow = { id: "ims-uuid", actorUserId: "actor-uuid", orgId: "org-uuid", isRevoked: false };
      const db = buildDb([[sessionRow]]);
      const svc = makeService(db);
      await svc.stop(makeActor(), "ims-uuid");
      expect(redis.set).toHaveBeenCalledWith("revoked:impersonation:ims-uuid", true);
    });

    it("succeeds without error when session is already revoked", async () => {
      const sessionRow = { id: "ims-uuid", actorUserId: "actor-uuid", orgId: "org-uuid", isRevoked: true };
      const db = buildDb([[sessionRow]]);
      const svc = makeService(db);
      const result = await svc.stop(makeActor(), "ims-uuid");
      expect(result.success).toBe(true);
    });
  });
});
