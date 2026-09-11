import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import {
  cancelModuleOwnershipTransfer,
  initiateModuleOwnershipTransfer,
  type ModuleOwnershipTransferDeps,
} from "../lib/module-ownership-transfers";

/**
 * Pass-through, so the transaction wrapper's own tenant-setup reads cannot shift
 * the order of the reads under test. The rules here are the lib's, not the
 * wrapper's.
 */
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    async (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
  ),
}));

/**
 * The rules of opening and withdrawing a module-ownership transfer.
 *
 * Before this spec, only one of them was caught by anything: dropping the
 * ownership gate from `initiate`. The "Module Admin may not cancel" case in
 * `module-access-new-capabilities.spec.ts` passes with the gate deleted from
 * `cancel` too, because the path then falls through to the initiator rule, which
 * happens to throw the same 403. Every other rule could go with all 249
 * module-access tests green: the target must be an ACTIVE member, the caller
 * must be one, the current owner cannot be the target, only the initiator or an
 * org owner may withdraw, nothing is withdrawn when nothing is pending — and all
 * six org predicates, including the one on the TARGET lookup, without which a
 * member of another organisation could be made a module's owner.
 *
 * Predicates are compiled and checked for the bound org, because a mocked
 * lookup returns whatever the mock says regardless of its WHERE.
 */

const dialect = new PgDialect();
const paramsOf = (cond: unknown) => dialect.sqlToQuery(cond as SQL).params;
const ORG = "org-ownership";

function actor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-owner",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

interface HarnessOptions {
  readonly gate?: "allow" | "deny";
  /** `organizationMembers.findFirst` results, in call order. */
  readonly members?: readonly unknown[];
  /** `select().from().where().limit()` results, in call order. */
  readonly selects?: readonly unknown[][];
}

function harness(options: HarnessOptions = {}) {
  const findFirst = jest.fn((_query: { where?: unknown }) => Promise.resolve(undefined as unknown));
  for (const member of options.members ?? []) findFirst.mockResolvedValueOnce(member);

  const selectWheres: jest.Mock[] = [];
  const select = jest.fn();
  for (const rows of options.selects ?? []) {
    const where = jest.fn((_cond: unknown) => ({ limit: jest.fn().mockResolvedValue(rows) }));
    selectWheres.push(where);
    select.mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where }) });
  }

  const insertValues = jest.fn((_row: Record<string, unknown>) => Promise.resolve(undefined));
  const insert = jest.fn((_table: unknown) => ({ values: insertValues }));
  const updateWhere = jest.fn((_cond: unknown) => Promise.resolve(undefined));
  const updateSet = jest.fn((_patch: Record<string, unknown>) => ({ where: updateWhere }));
  const update = jest.fn((_table: unknown) => ({ set: updateSet }));

  const gate = jest.fn((_actor: CurrentUserContext, _moduleKey: string) =>
    options.gate === "deny"
      ? Promise.reject(new ForbiddenException("not yours to move"))
      : Promise.resolve(),
  );

  const deps: ModuleOwnershipTransferDeps = {
    db: { select, insert, update, query: { organizationMembers: { findFirst } } } as unknown as Db,
    cache: {
      invalidate: jest.fn().mockResolvedValue(undefined),
      // The transfer namespace is busted per tenant, so the org is an argument
      // rather than a segment the caller pastes into the key itself.
      invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService,
    audit: { log: jest.fn() } as unknown as AuditService,
    assertOwnershipRights: gate,
  };
  return { deps, gate, findFirst, select, selectWheres, insert, insertValues, update, updateWhere };
}

const CALLER = { id: 11 };
const TARGET = { id: 12, status: "ACTIVE" };

describe("opening a transfer", () => {
  it("refuses before reading anything when the caller may not move ownership", async () => {
    const h = harness({ gate: "deny" });

    await expect(
      initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-target"),
    ).rejects.toThrow(ForbiddenException);
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("looks both the caller and the target up only among the caller's org's members", async () => {
    const h = harness({ members: [CALLER, TARGET], selects: [[{ ownerMembershipId: 9 }]] });
    await initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-target");

    expect(h.findFirst).toHaveBeenCalledTimes(2);
    expect(paramsOf(h.findFirst.mock.calls[0]?.[0]?.where)).toContain(ORG);
    expect(paramsOf(h.findFirst.mock.calls[1]?.[0]?.where)).toContain(ORG);
  });

  it("reads the current owner only in the caller's org", async () => {
    const h = harness({ members: [CALLER, TARGET], selects: [[{ ownerMembershipId: 9 }]] });
    await initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-target");

    expect(paramsOf(h.selectWheres[0]?.mock.calls[0]?.[0])).toContain(ORG);
  });

  it("refuses a caller who is not an active member, and writes nothing", async () => {
    const h = harness({ members: [undefined, TARGET], selects: [[{ ownerMembershipId: 9 }]] });

    await expect(
      initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-target"),
    ).rejects.toThrow(ForbiddenException);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("404s a target who is not a member of the org, and writes nothing", async () => {
    const h = harness({ members: [CALLER, undefined], selects: [[{ ownerMembershipId: 9 }]] });

    await expect(
      initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-stranger"),
    ).rejects.toThrow(NotFoundException);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("refuses a target whose membership is not ACTIVE, and writes nothing", async () => {
    const h = harness({
      members: [CALLER, { id: 12, status: "SUSPENDED" }],
      selects: [[{ ownerMembershipId: 9 }]],
    });

    await expect(
      initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-target"),
    ).rejects.toThrow(BadRequestException);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("refuses to transfer a module to the member who already owns it", async () => {
    const h = harness({ members: [CALLER, TARGET], selects: [[{ ownerMembershipId: 12 }]] });

    await expect(
      initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-target"),
    ).rejects.toThrow(BadRequestException);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("opens a pending transfer from the current owner that expires in 48 hours", async () => {
    const h = harness({ members: [CALLER, TARGET], selects: [[{ ownerMembershipId: 9 }]] });
    const before = Date.now();

    await expect(
      initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-target"),
    ).resolves.toEqual({ success: true });

    expect(h.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        scope: "MODULE",
        moduleKey: "hr",
        fromMembershipId: 9,
        initiatedByMembershipId: 11,
        toMembershipId: 12,
        status: "PENDING",
      }),
    );
    const expiresAt = h.insertValues.mock.calls[0]?.[0]?.expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);
    const hours = ((expiresAt as Date).getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(47.99);
    expect(hours).toBeLessThan(48.01);
  });

  it("answers 409 when the module already has a pending transfer", async () => {
    const h = harness({ members: [CALLER, TARGET], selects: [[{ ownerMembershipId: 9 }]] });
    h.insertValues.mockRejectedValueOnce(
      drizzleUniqueViolation("uniq_ownership_xfers_org_pending_module"),
    );

    await expect(
      initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-target"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rethrows any other database error from the insert untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "some_fk");
    const h = harness({ members: [CALLER, TARGET], selects: [[{ ownerMembershipId: 9 }]] });
    h.insertValues.mockRejectedValueOnce(fkViolation);

    await expect(
      initiateModuleOwnershipTransfer(h.deps, actor(), "hr", "u-target"),
    ).rejects.toBe(fkViolation);
  });
});

describe("withdrawing a transfer", () => {
  const PENDING = { id: "t-1", fromMembershipId: 11 };

  it("refuses before reading anything when the caller may not move ownership", async () => {
    const h = harness({ gate: "deny" });

    await expect(cancelModuleOwnershipTransfer(h.deps, actor(), "hr")).rejects.toThrow(
      ForbiddenException,
    );
    expect(h.select).not.toHaveBeenCalled();
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("reads the pending transfer only in the caller's org", async () => {
    const h = harness({ selects: [[PENDING]], members: [{ id: 11 }] });
    await cancelModuleOwnershipTransfer(h.deps, actor(), "hr");

    expect(paramsOf(h.selectWheres[0]?.mock.calls[0]?.[0])).toContain(ORG);
  });

  it("404s when nothing is pending, and writes nothing", async () => {
    const h = harness({ selects: [[]], members: [{ id: 11 }] });

    await expect(cancelModuleOwnershipTransfer(h.deps, actor(), "hr")).rejects.toThrow(
      NotFoundException,
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  /**
   * Holding ownership rights over the module is not enough: a transfer is the
   * initiator's proposal, and only they (or an org owner) may take it back.
   */
  it("refuses a caller who did not initiate the transfer, and writes nothing", async () => {
    const h = harness({ selects: [[PENDING]], members: [{ id: 99 }] });

    await expect(cancelModuleOwnershipTransfer(h.deps, actor(), "hr")).rejects.toThrow(
      ForbiddenException,
    );
    expect(h.update).not.toHaveBeenCalled();
  });

  it("asks who the caller is only within the caller's org", async () => {
    const h = harness({ selects: [[PENDING]], members: [{ id: 11 }] });
    await cancelModuleOwnershipTransfer(h.deps, actor(), "hr");

    expect(h.findFirst).toHaveBeenCalledTimes(1);
    expect(paramsOf(h.findFirst.mock.calls[0]?.[0]?.where)).toContain(ORG);
  });

  it("confines the withdrawal to the caller's org", async () => {
    const h = harness({ selects: [[PENDING]], members: [{ id: 11 }] });
    await cancelModuleOwnershipTransfer(h.deps, actor(), "hr");

    expect(h.updateWhere).toHaveBeenCalledTimes(1);
    expect(paramsOf(h.updateWhere.mock.calls[0]?.[0])).toContain(ORG);
  });

  it("lets an org owner withdraw a transfer somebody else initiated", async () => {
    const h = harness({ selects: [[PENDING]] });

    await expect(
      cancelModuleOwnershipTransfer(h.deps, actor({ isOrgOwner: true }), "hr"),
    ).resolves.toEqual({ success: true });
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledTimes(1);
  });
});
