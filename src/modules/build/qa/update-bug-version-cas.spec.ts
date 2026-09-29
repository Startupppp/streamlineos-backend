import { BugsService } from "./bugs.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TicketVersionConflictException } from "../core/tickets/ticket-version-conflict.exception";
import { updateBugSchema } from "./dto/bugs.schemas";

function makeU(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, true),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

const mockAccessGranted = {
  resolveUserPermissions: jest
    .fn()
    .mockResolvedValue(new Set(["build:manage"])),
} as unknown as AccessService;

function makeVersionedDb(ticketVersion: number, updateReturning: unknown[]) {
  const db = {
    query: {
      projects: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ managerMembershipId: null }),
      },
      tickets: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 1, status: "new", version: ticketVersion }),
      },
      workItemQaDetails: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ qaState: "new", reopenCount: 0 }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue(undefined),
      },
    },
    select: jest.fn(),
    transaction: jest
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db)),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(updateReturning),
        }),
      }),
    }),
  } as unknown as Db;
  return db;
}

describe("updateBugSchema — optional version field declared for stage-one CAS", () => {
  it("accepts a body without version — omitting the token must not break existing callers", () => {
    const result = updateBugSchema.safeParse({ title: "repro" });
    expect(result.success).toBe(true);
  });

  it("accepts a body with a valid positive integer version", () => {
    const result = updateBugSchema.safeParse({ title: "repro", version: 5 });
    expect(result.success).toBe(true);
  });

  it("rejects a zero version — version must be positive", () => {
    const result = updateBugSchema.safeParse({ title: "repro", version: 0 });
    expect(result.success).toBe(false);
  });
});

describe("BugsService.updateBug — version CAS (stage-one: accept-and-warn)", () => {
  it("throws TicketVersionConflictException carrying the current version when a stale token is supplied (i — stale token → 409)", async () => {
    const db = makeVersionedDb(5, [{ id: 1, status: "new" }]);
    const svc = new BugsService(db, mockAccessGranted, mockAudit);
    const error = await svc
      .updateBug(makeU("org-1"), 1, 1, { title: "fixed", version: 3 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketVersionConflictException);
    expect(
      (error as TicketVersionConflictException).getResponse(),
    ).toMatchObject({
      code: "PROJECTS_TICKET_CONFLICT",
      details: { currentVersion: 5 },
    });
  });

  it("makes no DB write when a stale token is detected — the update must not be called before the conflict is raised (BE-141 stale-negative pair)", async () => {
    const db = makeVersionedDb(5, [{ id: 1, status: "new" }]);
    const svc = new BugsService(db, mockAccessGranted, mockAudit);
    await svc
      .updateBug(makeU("org-1"), 1, 1, { title: "fixed", version: 3 })
      .catch(() => undefined);
    expect((db as unknown as { update: jest.Mock }).update).not.toHaveBeenCalled();
  });

  it("resolves without error when the supplied version matches the stored version (ii — correct token → 200)", async () => {
    const db = makeVersionedDb(5, [{ id: 1, status: "new" }]);
    const svc = new BugsService(db, mockAccessGranted, mockAudit);
    await expect(
      svc.updateBug(makeU("org-1"), 1, 1, { title: "fixed", version: 5 }),
    ).resolves.toBeDefined();
  });

  it("resolves without error when no version is supplied — omitting the token must never reject the request (iii — token omitted → success, breaking-change guard)", async () => {
    const db = makeVersionedDb(5, [{ id: 1, status: "new" }]);
    const svc = new BugsService(db, mockAccessGranted, mockAudit);
    await expect(
      svc.updateBug(makeU("org-1"), 1, 1, { title: "fixed" }),
    ).resolves.toBeDefined();
  });
});
