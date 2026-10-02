import { createTenantAwareDb, type DbWithClient } from "../../../common/tenant/tenant-db";
import { emailOutbox, invitationModuleAccess, invitations } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AccessService } from "../../access/access.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { EmailOutboxService } from "../../email/email-outbox.service";
import type { EmailDispatcher } from "../../email/email-provider-selection";
import { EmailService } from "../../email/email.service";
import type { EmailProviderService } from "../../email/email.provider";
import type { EmailSuppressionService } from "../../email/email-suppression.service";
import { InvitationCreateService } from "./invitation-create.service";
import type { MembershipAdmissionService } from "./membership-admission.service";

interface StagedWrite {
  table: unknown;
  rows: Record<string, unknown>[];
}

function harness(options: {
  failAfterEmail?: boolean;
  provider?: "resend" | "none";
  suppressed?: boolean;
} = {}) {
  const persisted: StagedWrite[] = [];
  const beforeCommit: StagedWrite[] = [];
  const rolledBack: StagedWrite[] = [];
  const visibleBeforeCommit: number[] = [];
  const rootInsert = jest.fn(() => {
    throw new Error("outbox escaped the invitation transaction");
  });

  const rawDb = {
    insert: rootInsert,
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
    transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      const staged: StagedWrite[] = [];
      const tx = {
        execute: jest.fn().mockResolvedValue([]),
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({
              for: jest.fn(() => ({ limit: jest.fn().mockResolvedValue([]) })),
            })),
          })),
        })),
        insert: jest.fn((table: unknown) => ({
          values: jest.fn((input: Record<string, unknown> | Record<string, unknown>[]) => {
            const rows = Array.isArray(input) ? input : [input];
            staged.push({ table, rows });
            const returning = jest.fn().mockResolvedValue(
              rows.map((row, index) => ({ id: row.id ?? `email-${index}`, email: row.email })),
            );
            return {
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve(undefined).then(resolve),
              onConflictDoNothing: jest.fn(() => ({ returning })),
              returning,
            };
          }),
        })),
        delete: jest.fn((table: unknown) => ({
          where: jest.fn(async () => {
            if (options.failAfterEmail && table === invitationModuleAccess)
              throw new Error("invitation transaction rolled back after email enqueue");
          }),
        })),
      };

      try {
        const result = await run(tx);
        beforeCommit.push(...staged);
        visibleBeforeCommit.push(persisted.length);
        persisted.push(...staged);
        return result;
      } catch (error) {
        rolledBack.push(...staged);
        throw error;
      }
    }),
  };

  const db = createTenantAwareDb(rawDb as unknown as DbWithClient);
  const provider: EmailDispatcher = {
    getEmailProvider: () => options.provider ?? "resend",
    sendEmailOnceDirect: jest.fn().mockResolvedValue(undefined),
    dispatchEmail: jest.fn().mockResolvedValue(undefined),
  };
  const suppression = {
    findSuppressed: jest.fn().mockResolvedValue(
      options.suppressed ? new Set(["invitee@example.com"]) : new Set<string>(),
    ),
  } as unknown as EmailSuppressionService;
  const outbox = new EmailOutboxService(db, suppression, provider);
  const email = new EmailService(outbox, provider as unknown as EmailProviderService);
  const admission = {
    screenMany: jest.fn(
      (_db: unknown, input: { emails: string[] }) =>
        Promise.resolve(
          new Map(input.emails.map((address) => [address, { kind: "clear" as const, userId: null }])),
        ),
    ),
  } as unknown as MembershipAdmissionService;
  const service = new InvitationCreateService(
    db as Db,
    { logMany: jest.fn() } as unknown as AuditService,
    { invalidateForOrg: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService,
    email,
    {
      headroomFor: jest.fn().mockResolvedValue({ limit: null, used: 0, available: null }),
      assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlanLimitsService,
    { recordSeatEvents: jest.fn().mockResolvedValue(undefined) } as unknown as SeatLedgerService,
    {} as AccessService,
    admission,
  );

  return { service, persisted, beforeCommit, rolledBack, visibleBeforeCommit, rootInsert, rawDb };
}

const invite = (service: InvitationCreateService) =>
  service.bulkInvite(
    "org-1",
    { userId: "actor-1", isOrgOwner: true },
    ["invitee@example.com"],
    "MEMBER",
  );

describe("InvitationCreateService and EmailOutboxService share one tenant transaction", () => {
  it("commits the invitation and pending email together", async () => {
    const h = harness();

    const result = await invite(h.service);

    expect(result.results[0]).toMatchObject({ success: true, deliveryQueued: true });
    expect(h.beforeCommit.some((write) => write.table === invitations)).toBe(true);
    expect(h.beforeCommit.some((write) => write.table === emailOutbox)).toBe(true);
    expect(h.visibleBeforeCommit).toEqual([0]);
    expect(h.persisted).toEqual(h.beforeCommit);
    expect(h.rootInsert).not.toHaveBeenCalled();
    expect(h.rawDb.transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    { provider: "resend" as const, suppressed: false, status: "PENDING" },
    { provider: "none" as const, suppressed: false, status: "FAILED" },
    { provider: "resend" as const, suppressed: true, status: "SUPPRESSED" },
  ])("rolls back invitation and $status email together", async (scenario) => {
    const h = harness({ ...scenario, failAfterEmail: true });

    await expect(invite(h.service)).rejects.toThrow(
      "invitation transaction rolled back after email enqueue",
    );

    expect(h.rolledBack.some((write) => write.table === invitations)).toBe(true);
    expect(h.rolledBack).toContainEqual(
      expect.objectContaining({
        table: emailOutbox,
        rows: [expect.objectContaining({ status: scenario.status })],
      }),
    );
    expect(h.persisted).toEqual([]);
    expect(h.rootInsert).not.toHaveBeenCalled();
  });
});
