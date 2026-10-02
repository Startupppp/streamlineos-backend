jest.mock("../../../common/rbac/assert-may-grant-role", () => ({
  assertMayGrantRole: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (_db: unknown, run: (tx: unknown) => Promise<unknown>) =>
      run((globalThis as { __bulkInviteTx?: unknown }).__bulkInviteTx),
  ),
}));

import { InvitationCreateService } from "./invitation-create.service";
import { canonicalAdmissionEmail } from "./membership-admission.service";
import { invitationEvents } from "../../../db/schema";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EmailService } from "../../email/email.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import type { AccessService } from "../../access/access.service";
import type { MembershipAdmissionService } from "./membership-admission.service";
import type { Db } from "../../../db/drizzle.module";

interface HarnessOptions {
  refused?: ReadonlySet<string>;
  omitInserted?: ReadonlySet<string>;
  available?: number | null;
}

function harness(options: HarnessOptions = {}) {
  const pendingLimit = jest.fn().mockResolvedValue([]);
  const select = jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        for: jest.fn(() => ({ limit: pendingLimit })),
      })),
    })),
  }));
  const insertedInvitationRows: Array<{ id: string; email: string }> = [];
  const insertedEventRows: Array<{ invitationId: string; event: string }> = [];
  const insert = jest.fn(() => ({
    values: jest.fn((input: unknown) => {
      const rows = (Array.isArray(input) ? input : [input]) as Array<{
        id?: string;
        email?: string;
      }>;
      const returned = rows
        .filter((row) => row.email && !options.omitInserted?.has(row.email))
        .map((row) => ({ id: row.id!, email: row.email! }));
      insertedInvitationRows.push(...returned);
      insertedEventRows.push(
        ...(rows as Array<{ invitationId?: string; event?: string }>)
          .filter((row) => row.invitationId && row.event)
          .map((row) => ({ invitationId: row.invitationId!, event: row.event! })),
      );
      return {
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(undefined).then(resolve),
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn().mockResolvedValue(returned),
        })),
      };
    }),
  }));
  const tx = {
    select,
    insert,
    execute: jest.fn().mockResolvedValue([]),
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
    })),
    delete: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
  };
  (globalThis as { __bulkInviteTx?: unknown }).__bulkInviteTx = tx;

  const db = {
    query: {
      organizations: {
        findFirst: jest.fn().mockResolvedValue({
          name: "Acme",
          status: "ACTIVE",
          deletedAt: null,
        }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 17 }),
      },
    },
  } as unknown as Db;
  const screenMany = jest.fn(
    (_executor: unknown, input: { emails: string[] }) =>
      Promise.resolve(
        new Map(
          input.emails.map((email) => [
            email,
            options.refused?.has(email)
              ? {
                  kind: "conflict" as const,
                  reason: "already-member" as const,
                  message: "Already a member",
                }
              : { kind: "clear" as const, userId: null },
          ]),
        ),
      ),
  );
  const queueInvitationEmails = jest.fn((items: readonly unknown[]) =>
    Promise.resolve(items.map(() => ({ queued: true as const }))),
  );
  const headroomFor = jest.fn().mockResolvedValue({
    limit: options.available,
    used: 0,
    available: options.available ?? null,
  });
  const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
  const recordSeatEvents = jest.fn().mockResolvedValue(undefined);
  const invalidateForOrg = jest.fn().mockResolvedValue(undefined);
  const logMany = jest.fn();
  const service = new InvitationCreateService(
    db,
    { log: jest.fn(), logMany } as unknown as AuditService,
    { invalidateForOrg } as unknown as CacheService,
    { queueInvitationEmails } as unknown as EmailService,
    { headroomFor, assertWithinLimit } as unknown as PlanLimitsService,
    { recordSeatEvents } as unknown as SeatLedgerService,
    {} as AccessService,
    { screenMany } as unknown as MembershipAdmissionService,
  );

  return {
    service,
    tx,
    screenMany,
    queueInvitationEmails,
    headroomFor,
    assertWithinLimit,
    recordSeatEvents,
    invalidateForOrg,
    logMany,
    insertedInvitationRows,
    insertedEventRows,
  };
}

describe("InvitationCreateService.bulkInvite", () => {
  const orgId = "org-1";
  const actor = { userId: "actor-1", isOrgOwner: true };

  afterEach(() => {
    delete (globalThis as { __bulkInviteTx?: unknown }).__bulkInviteTx;
  });

  it("canonicalizes once, reports later duplicates, and persists only the first occurrence", async () => {
    const h = harness();
    const result = await h.service.bulkInvite(
      orgId,
      actor,
      ["A@x.com", " a@X.com ", "other@example.com"],
      "MEMBER",
    );

    expect(canonicalAdmissionEmail(" A@x.com ")).toBe("a@x.com");
    expect(h.screenMany).toHaveBeenCalledWith(expect.anything(), {
      orgId,
      emails: ["a@x.com", "other@example.com"],
    });
    expect(result.results.map((row) => row.success)).toEqual([true, false, true]);
    expect(result.results[1]).toMatchObject({
      originalEmail: " a@X.com ",
      isDuplicate: true,
    });
    expect(h.insertedInvitationRows.map((row) => row.email)).toEqual([
      "a@x.com",
      "other@example.com",
    ]);
  });

  it("keeps admission refusals per-row and never queues them for delivery", async () => {
    const h = harness({ refused: new Set(["member@example.com"]) });
    const result = await h.service.bulkInvite(
      orgId,
      actor,
      ["member@example.com", "fresh@example.com"],
      "MEMBER",
    );

    expect(result.results[0]).toMatchObject({ success: false, error: "Already a member" });
    expect(result.results[1]).toMatchObject({ success: true });
    expect(h.queueInvitationEmails).toHaveBeenCalledWith([
      expect.objectContaining({ email: "fresh@example.com", organizationId: orgId }),
    ]);
  });

  it("keeps persisted invitations successful while recording suppressed and unavailable delivery", async () => {
    const h = harness();
    h.queueInvitationEmails.mockResolvedValueOnce([
      { queued: true },
      { queued: false, reason: "recipient suppressed" },
      { queued: false, reason: "provider unavailable" },
    ]);

    const result = await h.service.bulkInvite(
      orgId,
      actor,
      ["queued@example.com", "suppressed@example.com", "unavailable@example.com"],
      "MEMBER",
    );

    expect(result.results).toEqual([
      expect.objectContaining({ email: "queued@example.com", success: true, deliveryQueued: true }),
      expect.objectContaining({ email: "suppressed@example.com", success: true, deliveryQueued: false }),
      expect.objectContaining({ email: "unavailable@example.com", success: true, deliveryQueued: false }),
    ]);
    expect(h.tx.insert).toHaveBeenCalledWith(invitationEvents);
    expect(h.insertedEventRows.filter((row) => row.event === "DELIVERY_FAILED")).toEqual([
      { invitationId: result.results[1]?.invitationId, event: "DELIVERY_FAILED" },
      { invitationId: result.results[2]?.invitationId, event: "DELIVERY_FAILED" },
    ]);
    expect(h.insertedInvitationRows).toHaveLength(3);
  });

  it("rejects an incomplete queue result instead of claiming delivery", async () => {
    const h = harness();
    h.queueInvitationEmails.mockResolvedValueOnce([]);

    await expect(
      h.service.bulkInvite(orgId, actor, ["queued@example.com"], "MEMBER"),
    ).rejects.toThrow("incomplete batch result");
  });

  it("maps a concurrent unique winner to one failed row without aborting the batch", async () => {
    const h = harness({ omitInserted: new Set(["raced@example.com"]) });
    const result = await h.service.bulkInvite(
      orgId,
      actor,
      ["first@example.com", "raced@example.com", "third@example.com"],
      "MEMBER",
    );

    expect(result.results.map((row) => row.success)).toEqual([true, false, true]);
    expect(result.results[1]?.error).toBe("An invitation is already pending for this email");
    expect(h.queueInvitationEmails.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("holds the same collaborator-call budget for 500 rows as for one row", async () => {
    const one = harness();
    await one.service.bulkInvite(orgId, actor, ["one@example.com"], "MEMBER");

    const fiveHundred = harness();
    await fiveHundred.service.bulkInvite(
      orgId,
      actor,
      Array.from({ length: 500 }, (_unused, index) => `person-${index}@example.com`),
      "MEMBER",
    );

    for (const h of [one, fiveHundred]) {
      expect(h.screenMany).toHaveBeenCalledTimes(1);
      expect(h.tx.select).toHaveBeenCalledTimes(1);
      expect(h.headroomFor).toHaveBeenCalledTimes(1);
      expect(h.assertWithinLimit).toHaveBeenCalledTimes(1);
      expect(h.recordSeatEvents).toHaveBeenCalledTimes(1);
      expect(h.queueInvitationEmails).toHaveBeenCalledTimes(1);
      expect(h.invalidateForOrg).toHaveBeenCalledTimes(1);
      expect(h.logMany).toHaveBeenCalledTimes(1);
    }
    expect(fiveHundred.queueInvitationEmails.mock.calls[0]?.[0]).toHaveLength(500);
  });

  it("uses one locked headroom result to preserve per-row quota outcomes", async () => {
    const h = harness({ available: 1 });
    const result = await h.service.bulkInvite(
      orgId,
      actor,
      ["first@example.com", "second@example.com"],
      "MEMBER",
    );

    expect(result.results.map((row) => row.success)).toEqual([true, false]);
    expect(result.results[1]?.error).toContain("member limit");
    expect(h.assertWithinLimit).toHaveBeenCalledWith(orgId, "members", 1, h.tx);
  });
});
