import type { AfterCommitHook } from "../../../common/tenant/tenant-context";

const mockRunInTenantTransaction = jest.fn();
const mockRegisterAfterCommit = jest.fn();

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (...args: unknown[]) => mockRunInTenantTransaction(...args),
}));

jest.mock("../../../common/tenant", () => ({
  registerAfterCommit: (hook: AfterCommitHook) => mockRegisterAfterCommit(hook),
}));

jest.mock("../../../common/rbac/assert-may-grant-role", () => ({
  assertMayGrantRole: jest.fn(() => Promise.resolve()),
}));

import { InvitationCreateService } from "./invitation-create.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { EmailService } from "../../email/email.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import type { AccessService } from "../../access/access.service";
import type { MembershipAdmissionService } from "./membership-admission.service";

const ORG_ID = "org-delivery";
const ACTOR = { userId: "user-actor", isOrgOwner: true };

interface Harness {
  service: InvitationCreateService;
  email: {
    queueInvitationEmail: jest.Mock;
    queueInvitationEmails: jest.Mock;
    sendInvitationEmail: jest.Mock;
  };
  screen: jest.Mock;
  screenMany: jest.Mock;
  written: Record<string, unknown>[];
  txCallbackRuns: number;
}

function buildHarness(options: { writeRejectsWith?: Error } = {}): Harness {
  const state = { txCallbackRuns: 0 };
  const written: Record<string, unknown>[] = [];

  mockRunInTenantTransaction.mockImplementation(
    async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      if (options.writeRejectsWith) throw options.writeRejectsWith;
      state.txCallbackRuns += 1;
      const tx = {
        execute: jest.fn(() => Promise.resolve(undefined)),
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({
              for: jest.fn(() => ({ limit: jest.fn(() => Promise.resolve([])) })),
            })),
          })),
        })),
        update: jest.fn(() => ({
          set: jest.fn(() => ({
            where: jest.fn(() => ({ returning: jest.fn(() => Promise.resolve([])) })),
          })),
        })),
        insert: jest.fn(() => ({
          values: jest.fn((input: Record<string, unknown> | Record<string, unknown>[]) => {
            const rows = Array.isArray(input) ? input : [input];
            written.push(...rows);
            const returned = rows.map((row) => ({ id: row.id, email: row.email }));
            return {
              then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
              onConflictDoNothing: jest.fn(() => ({
                returning: jest.fn(() => Promise.resolve(returned)),
              })),
            };
          }),
        })),
      };
      return fn(tx);
    },
  );

  const db = {
    query: {
      organizations: {
        findFirst: jest.fn(() =>
          Promise.resolve({ name: "Acme", status: "ACTIVE", deletedAt: null }),
        ),
      },
      organizationMembers: {
        findFirst: jest.fn(() => Promise.resolve({ id: "membership-actor" })),
      },
    },
  } as unknown as Db;

  const email = {
    queueInvitationEmail: jest.fn(() => Promise.resolve()),
    queueInvitationEmails: jest.fn(() => Promise.resolve([])),
    sendInvitationEmail: jest.fn(() => Promise.resolve()),
  };

  const screen = jest.fn(() => Promise.resolve({ kind: "clear", userId: null }));
  const screenMany = jest.fn(
    (_executor: unknown, input: { emails: string[] }) =>
      Promise.resolve(
        new Map(input.emails.map((email) => [email, { kind: "clear", userId: null }])),
      ),
  );

  const service = new InvitationCreateService(
    db,
    { log: jest.fn(), logMany: jest.fn() } as unknown as AuditService,
    { invalidateForOrg: jest.fn(() => Promise.resolve()) } as unknown as CacheService,
    email as unknown as EmailService,
    {
      assertWithinLimit: jest.fn(() => Promise.resolve()),
      headroomFor: jest.fn(() => Promise.resolve({ limit: 100, used: 0, available: 100 })),
    } as unknown as PlanLimitsService,
    {
      recordSeatEvent: jest.fn(() => Promise.resolve()),
      recordSeatEvents: jest.fn(() => Promise.resolve()),
    } as unknown as SeatLedgerService,
    {} as unknown as AccessService,
    { screen, screenMany } as unknown as MembershipAdmissionService,
  );

  return {
    service,
    email,
    screen,
    screenMany,
    written,
    get txCallbackRuns() {
      return state.txCallbackRuns;
    },
  };
}

describe("invitation delivery is ordered behind the durable write", () => {
  beforeEach(() => {
    mockRunInTenantTransaction.mockReset();
    mockRegisterAfterCommit.mockReset();
    mockRegisterAfterCommit.mockReturnValue(true);
  });

  it("sends nothing when the invitation write rolls back", async () => {
    const rollback = new Error("quota lock lost — transaction rolled back");
    const harness = buildHarness({ writeRejectsWith: rollback });

    await expect(
      harness.service.invite(ORG_ID, ACTOR, "invitee@example.com", "MEMBER"),
    ).rejects.toThrow("quota lock lost");

    expect(harness.email.queueInvitationEmail).not.toHaveBeenCalled();
    expect(harness.email.sendInvitationEmail).not.toHaveBeenCalled();
    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
  });

  it("runs the write transaction callback, so every assertion above is reached", async () => {
    const harness = buildHarness();

    await harness.service.invite(ORG_ID, ACTOR, "invitee@example.com", "MEMBER");

    expect(harness.txCallbackRuns).toBeGreaterThan(0);
  });

  it("canonicalises the address before handing it to delivery", async () => {
    const harness = buildHarness();

    await harness.service.invite(ORG_ID, ACTOR, "  Invitee@Example.COM  ", "MEMBER");

    const hook = mockRegisterAfterCommit.mock.calls[0]?.[0] as AfterCommitHook;
    await hook();
    expect(harness.email.sendInvitationEmail).toHaveBeenCalledWith(
      "invitee@example.com",
      expect.any(String),
      "Acme",
    );
  });

  it("enqueue delivery awaits the durable queue and never fires an untracked send", async () => {
    const harness = buildHarness();

    await harness.service.bulkInvite(
      ORG_ID,
      ACTOR,
      ["invitee@example.com"],
      "MEMBER",
      "enqueue",
    );

    expect(harness.email.queueInvitationEmails).toHaveBeenCalledTimes(1);
    expect(harness.email.sendInvitationEmail).not.toHaveBeenCalled();
    expect(mockRegisterAfterCommit).not.toHaveBeenCalled();
  });

  it("background delivery is deferred to after-commit rather than run beside the open write", async () => {
    const harness = buildHarness();

    await harness.service.invite(ORG_ID, ACTOR, "invitee@example.com", "MEMBER");

    expect(mockRegisterAfterCommit).toHaveBeenCalledTimes(1);
    expect(harness.email.sendInvitationEmail).not.toHaveBeenCalled();

    const hook = mockRegisterAfterCommit.mock.calls[0]?.[0] as AfterCommitHook;
    await hook();
    expect(harness.email.sendInvitationEmail).toHaveBeenCalledTimes(1);
  });

  it("falls back to an inline send when there is no ambient context to defer into", async () => {
    const harness = buildHarness();
    mockRegisterAfterCommit.mockReturnValue(false);

    await harness.service.invite(ORG_ID, ACTOR, "invitee@example.com", "MEMBER");

    expect(harness.email.sendInvitationEmail).toHaveBeenCalledTimes(1);
  });
});

describe("the setup batch boundary when the wizard UI is bypassed", () => {
  beforeEach(() => {
    mockRunInTenantTransaction.mockReset();
    mockRegisterAfterCommit.mockReset();
    mockRegisterAfterCommit.mockReturnValue(true);
  });

  it("honours the intended role on every row of the batch", async () => {
    const harness = buildHarness();

    await harness.service.bulkInvite(
      ORG_ID,
      ACTOR,
      ["one@example.com", "two@example.com"],
      "ORG_ADMIN",
      "enqueue",
    );

    const invitationRows = harness.written.filter((row) => "tokenHash" in row);
    expect(invitationRows).toHaveLength(2);
    for (const row of invitationRows) expect(row.role).toBe("ORG_ADMIN");
  });

  it("returns a per-recipient outcome for a refused row and still delivers the rest", async () => {
    const harness = buildHarness();
    harness.screenMany.mockImplementation((_executor: unknown, input: { emails: string[] }) =>
      Promise.resolve(
        new Map(
          input.emails.map((email) => [
            email,
            email === "member@example.com"
              ? { kind: "conflict", reason: "already-member", message: "Already a member" }
              : { kind: "clear", userId: null },
          ]),
        ),
      ),
    );

    const { results, deliveryMode } = await harness.service.bulkInvite(
      ORG_ID,
      ACTOR,
      ["member@example.com", "fresh@example.com"],
      "MEMBER",
      "enqueue",
    );

    expect(deliveryMode).toBe("enqueue");
    expect(results).toHaveLength(2);
    const refused = results.find((row) => row.email === "member@example.com");
    expect(refused?.success).toBe(false);
    expect(refused?.error).toBeTruthy();
    expect(results.find((row) => row.email === "fresh@example.com")?.success).toBe(true);
    expect(harness.email.queueInvitationEmails).toHaveBeenCalledTimes(1);
    expect(harness.email.queueInvitationEmails).toHaveBeenCalledWith([
      expect.objectContaining({
        email: "fresh@example.com",
        token: expect.any(String),
        organizationName: "Acme",
        organizationId: ORG_ID,
      }),
    ]);
  });

  it("never delivers an invitation to an address that already holds a membership", async () => {
    const harness = buildHarness();
    harness.screenMany.mockImplementation((_executor: unknown, input: { emails: string[] }) =>
      Promise.resolve(
        new Map(
          input.emails.map((email) => [
            email,
            { kind: "conflict", reason: "already-member", message: "Already a member" },
          ]),
        ),
      ),
    );

    const { results } = await harness.service.bulkInvite(
      ORG_ID,
      ACTOR,
      ["owner@example.com"],
      "MEMBER",
      "enqueue",
    );

    expect(results[0]?.success).toBe(false);
    expect(harness.email.queueInvitationEmails).not.toHaveBeenCalled();
    expect(harness.email.sendInvitationEmail).not.toHaveBeenCalled();
    expect(harness.written).toHaveLength(0);
  });

  it("creates no employment, worker or payroll row for a teammate access invitation", async () => {
    const harness = buildHarness();

    await harness.service.bulkInvite(
      ORG_ID,
      ACTOR,
      ["teammate@example.com"],
      "MEMBER",
      "enqueue",
    );

    const employmentShaped = harness.written.filter(
      (row) =>
        "employeeNumber" in row ||
        "workerId" in row ||
        "organizationPersonId" in row ||
        "salary" in row ||
        "ctc" in row,
    );
    expect(employmentShaped).toEqual([]);
    expect(harness.written.every((row) => "tokenHash" in row || "event" in row)).toBe(true);
  });
});

describe("an after-commit hook owns its work until the work is done", () => {
  beforeEach(() => {
    mockRunInTenantTransaction.mockReset();
    mockRegisterAfterCommit.mockReset();
    mockRegisterAfterCommit.mockReturnValue(true);
  });

  it("does not resolve until the provider send has settled", async () => {
    const harness = buildHarness();
    let settle: (() => void) | undefined;
    harness.email.sendInvitationEmail.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );

    await harness.service.invite(ORG_ID, ACTOR, "invitee@example.com", "MEMBER");
    const hook = mockRegisterAfterCommit.mock.calls[0]?.[0] as AfterCommitHook;

    let hookSettled = false;
    const hookPromise = hook();
    void hookPromise.then(() => {
      hookSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(hookSettled).toBe(false);

    settle?.();
    await hookPromise;
    expect(hookSettled).toBe(true);
  });
});
