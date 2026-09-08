import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { NotificationsLifecycleService } from "src/modules/notifications/notifications-lifecycle.service";
import { RecruitmentCandidateOpsService } from "src/modules/hr/recruitment/recruitment-candidate-ops.service";
import { SurveyParticipantService } from "src/modules/surveys/survey-participant.service";
import { KbTagsService } from "src/modules/kb/core/kb-tags.service";
import { ApprovalsBulkService } from "src/modules/timesheets/core/approvals-bulk.service";
import type { ApprovalsService } from "src/modules/timesheets/core/approvals.service";
import type { TimesheetsAuditService } from "src/modules/timesheets/core/timesheets-audit.service";
import type { RateResolverService } from "src/modules/timesheets/core/rate-resolver.service";
import type { CacheService } from "src/common/cache/cache.service";
import type { AuditService } from "src/common/audit/audit.service";
import type { EmailService } from "src/modules/email/email.service";
import type { AutomationService } from "src/modules/automation/automation.service";
import type { NotificationEventService } from "src/modules/notifications/notification-event.service";
import type { Db } from "src/db/drizzle.module";
import type { CurrentUserContext } from "src/common/auth/backend-claims";

/**
 * Recorded predicates hold live Drizzle column objects, which are circular, so
 * every assertion below reads a COUNT rather than deep-comparing the recording —
 * a failed deep compare cannot be serialised back from the jest worker and turns
 * a real regression into "test suite failed to run".
 */

/**
 * A bulk endpoint handed a mixed-tenant id list must fail the WHOLE request.
 * Narrowing the work to the rows the caller owns and answering `200` is the
 * defect twice over: the caller is told every id was acted on, and the gap
 * between the requested and the affected count is an existence oracle over
 * another tenant's table.
 *
 * These run the services. A source-text assertion cannot see that nothing was
 * written on the miss, and "nothing was written" is the half of the property
 * that actually protects the other tenant — `bulkReject` sends real rejection
 * emails to whatever subset it decides it owns.
 *
 * A cross-tenant miss is 404, never 403: a 403 confirms the record exists.
 */

const ORG_ATTACKER = "org-b-attacker";
const OWNED_ID = 11;
const FOREIGN_ID = 99;

interface Recorder {
  readonly selectWhere: unknown[];
  readonly updateWhere: unknown[];
  readonly deleteWhere: unknown[];
  readonly inserted: unknown[];
}

/**
 * Returns each queued result set in turn, so a service that reads its ownership
 * check before writing sees exactly the rows the tenant predicate would return.
 * Every write is recorded rather than performed, which is what lets the
 * no-write-on-miss assertions be real.
 */
function makeDb(selectResults: unknown[][]): { db: Db; rec: Recorder } {
  const rec: Recorder = { selectWhere: [], updateWhere: [], deleteWhere: [], inserted: [] };
  const queue = [...selectResults];
  const nextRows = (): unknown[] => queue.shift() ?? [];

  const readChain = (where: unknown) => {
    rec.selectWhere.push(where);
    const rows = nextRows();
    const settled = Promise.resolve(rows);
    return Object.assign(settled, {
      limit: () => Promise.resolve(rows),
      orderBy: () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) }),
    });
  };

  const table = {
    findFirst: (opts?: { where?: unknown }) => {
      if (opts?.where !== undefined) rec.selectWhere.push(opts.where);
      return Promise.resolve(nextRows()[0]);
    },
    findMany: (opts?: { where?: unknown }) => {
      if (opts?.where !== undefined) rec.selectWhere.push(opts.where);
      return Promise.resolve(nextRows());
    },
  };

  const db = {
    select: () => ({ from: () => ({ where: readChain, innerJoin: () => ({ where: readChain }) }) }),
    update: () => ({
      set: () => ({
        where: (where: unknown) => {
          rec.updateWhere.push(where);
          return Object.assign(Promise.resolve(undefined), {
            returning: () => Promise.resolve([{ id: OWNED_ID }]),
          });
        },
      }),
    }),
    delete: () => ({
      where: (where: unknown) => {
        rec.deleteWhere.push(where);
        return Promise.resolve(undefined);
      },
    }),
    insert: () => ({
      values: (values: unknown) => {
        rec.inserted.push(values);
        const settled = Promise.resolve([{ id: 1 }]);
        return Object.assign(settled, {
          onConflictDoNothing: () => Object.assign(Promise.resolve([{ id: 1 }]), {
            returning: () => Promise.resolve([{ id: 1 }]),
          }),
          returning: () => Promise.resolve([{ id: 1 }]),
        });
      },
    }),
    transaction: <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => callback(db),
    query: new Proxy({}, { get: () => table }),
  };
  return { db: db as unknown as Db, rec };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error("the request was not refused"),
    (error: unknown) => error,
  );
}

function expectNotFoundNotForbidden(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(NotFoundException);
  expect(thrown).not.toBeInstanceOf(ForbiddenException);
}

describe("BOLA probe — notifications bulk actions refuse a mixed-tenant id list", () => {
  const membership = [{ id: 7 }];

  const service = (ownedRows: unknown[]) => {
    const { db, rec } = makeDb([membership, ownedRows]);
    const notifications = new NotificationsLifecycleService(
      db,
      { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService,
      { emit: jest.fn() } as unknown as NotificationEventService,
    );
    return { notifications, rec };
  };

  it("CROSS-TENANT-MISS: a list holding one foreign id is refused with 404, not 403", async () => {
    const { notifications } = service([{ id: OWNED_ID }]);
    expectNotFoundNotForbidden(
      await refusal(notifications.bulkDelete(ORG_ATTACKER, "u1", { ids: [OWNED_ID, FOREIGN_ID] })),
    );
  });

  it("NO-WRITE-ON-MISS: not even the owned subset is touched", async () => {
    const { notifications, rec } = service([{ id: OWNED_ID }]);
    await refusal(notifications.bulkArchive(ORG_ATTACKER, "u1", { ids: [OWNED_ID, FOREIGN_ID] }));
    expect(rec.updateWhere.length).toBe(0);
  });

  it("SAME-TENANT: a wholly owned list still succeeds, so the guard is not a blanket denial", async () => {
    const { notifications, rec } = service([{ id: OWNED_ID }, { id: 12 }]);
    await expect(
      notifications.bulkMarkRead(ORG_ATTACKER, "u1", { ids: [OWNED_ID, 12] }),
    ).resolves.toEqual({ success: true });
    expect(rec.updateWhere.length).toBe(1);
  });
});

describe("BOLA probe — recruitment bulk actions refuse a mixed-tenant candidate list", () => {
  const build = (ownedRows: unknown[]) => {
    const { db, rec } = makeDb([ownedRows]);
    const email = { sendEmail: jest.fn().mockResolvedValue(undefined) } as unknown as EmailService;
    const ops = new RecruitmentCandidateOpsService(
      db,
      { log: jest.fn() } as unknown as AuditService,
      { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService,
      email,
      { runAutomationsForEvent: jest.fn() } as unknown as AutomationService,
    );
    return { ops, rec, email };
  };

  const owned = { id: OWNED_ID, firstName: "A", lastName: "B", email: "a@b.test", status: "NEW" };

  it("CROSS-TENANT-MISS: bulkReject on a mixed list is refused with 404, not 403", async () => {
    const { ops } = build([owned]);
    expectNotFoundNotForbidden(
      await refusal(
        ops.bulkReject(ORG_ATTACKER, "u1", {
          candidateIds: [OWNED_ID, FOREIGN_ID],
          sendRejectionEmail: true,
        }),
      ),
    );
  });

  it("NO-SIDE-EFFECT-ON-MISS: no rejection email is sent to the owned subset", async () => {
    const { ops, rec, email } = build([owned]);
    await refusal(
      ops.bulkReject(ORG_ATTACKER, "u1", {
        candidateIds: [OWNED_ID, FOREIGN_ID],
        sendRejectionEmail: true,
      }),
    );
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(rec.updateWhere.length).toBe(0);
  });

  it("CROSS-TENANT-MISS: bulkShortlist on a mixed list is refused the same way", async () => {
    const { ops, rec } = build([owned]);
    expectNotFoundNotForbidden(
      await refusal(ops.bulkShortlist(ORG_ATTACKER, "u1", { candidateIds: [OWNED_ID, FOREIGN_ID] })),
    );
    expect(rec.updateWhere.length).toBe(0);
  });

  it("SAME-TENANT: a wholly owned list still shortlists", async () => {
    const { ops, rec } = build([owned, { ...owned, id: 12 }]);
    await expect(
      ops.bulkShortlist(ORG_ATTACKER, "u1", { candidateIds: [OWNED_ID, 12] }),
    ).resolves.toEqual({ shortlisted: 2, skipped: 0 });
    expect(rec.updateWhere.length).toBe(1);
  });
});

describe("BOLA probe — survey invitations refuse a mixed-tenant participant list", () => {
  const build = (ownedRows: unknown[]) => {
    const { db, rec } = makeDb([ownedRows, ownedRows]);
    return { participants: new SurveyParticipantService(db), rec };
  };

  it("CROSS-TENANT-MISS: invite is refused with 404 and writes nothing", async () => {
    const { participants, rec } = build([{ id: OWNED_ID }]);
    expectNotFoundNotForbidden(
      await refusal(participants.invite(ORG_ATTACKER, 1, [OWNED_ID, FOREIGN_ID])),
    );
    expect(rec.updateWhere.length).toBe(0);
  });

  it("COUNT-HONESTY: a successful invite reports the ids it actually acted on", async () => {
    const { participants } = build([{ id: OWNED_ID }, { id: 12 }]);
    await expect(participants.invite(ORG_ATTACKER, 1, [OWNED_ID, 12])).resolves.toEqual({
      success: true,
      count: 2,
    });
  });
});

describe("BOLA probe — kb article tags refuse a foreign tag or article", () => {
  it("CROSS-TENANT-MISS: a foreign tag id is refused with 404 and nothing is written", async () => {
    const { db, rec } = makeDb([[{ id: 1 }], [{ id: OWNED_ID, orgId: ORG_ATTACKER, name: "t", slug: "t", createdAt: new Date() }]]);
    const tags = new KbTagsService(db);
    expectNotFoundNotForbidden(
      await refusal(tags.setArticleTags(ORG_ATTACKER, 1, { tagIds: [OWNED_ID, FOREIGN_ID] })),
    );
    expect(rec.inserted.length).toBe(0);
    expect(rec.deleteWhere.length).toBe(0);
  });

  it("CROSS-TENANT-MISS: a foreign article id is refused before any tag is read", async () => {
    const { db, rec } = makeDb([[]]);
    const tags = new KbTagsService(db);
    expectNotFoundNotForbidden(await refusal(tags.setArticleTags(ORG_ATTACKER, 4242, { tagIds: [] })));
    expect(rec.deleteWhere.length).toBe(0);
  });
});

describe("BOLA probe — timesheet bulk approvals refuse a mixed-tenant period list", () => {
  const actor: CurrentUserContext = {
    userId: "u1",
    orgId: ORG_ATTACKER,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  };

  const build = (ownedRows: unknown[], rest: unknown[][] = []) => {
    const { db, rec } = makeDb([ownedRows, ...rest]);
    const approvals = {
      approveSinglePeriod: jest.fn().mockResolvedValue(undefined),
      assertCanActOnPeriod: jest.fn().mockResolvedValue(undefined),
      activeDelegationsToActor: jest.fn().mockResolvedValue(new Set<number>()),
    } as unknown as ApprovalsService;
    const bulk = new ApprovalsBulkService(
      db,
      { record: jest.fn(), recordMany: jest.fn() } as unknown as TimesheetsAuditService,
      approvals,
      { resolveMany: jest.fn().mockResolvedValue([]) } as unknown as RateResolverService,
    );
    return { bulk, rec, approvals };
  };

  /**
   * The old failure mode here was subtler than a silent subset:
   * `isExpectedApprovalSkip` swallows the cross-tenant `NotFoundException` and
   * counts it as `skipped`, so a mixed list returned `200 {approved: 1,
   * skipped: 1}` — indistinguishable from a period that was simply not
   * submitted.
   */
  it("CROSS-TENANT-MISS: bulkApprove refuses rather than folding the foreign id into skipped", async () => {
    const { bulk, approvals } = build([{ id: OWNED_ID }]);
    expectNotFoundNotForbidden(
      await refusal(bulk.bulkApprove(actor, { periodIds: [OWNED_ID, FOREIGN_ID] })),
    );
    expect(approvals.approveSinglePeriod).not.toHaveBeenCalled();
  });

  it("CROSS-TENANT-MISS: bulkReject refuses and writes nothing", async () => {
    const { bulk, rec } = build([{ id: OWNED_ID }]);
    expectNotFoundNotForbidden(
      await refusal(bulk.bulkReject(actor, { periodIds: [OWNED_ID, FOREIGN_ID], reason: "no" })),
    );
    expect(rec.updateWhere.length).toBe(0);
  });

  it("SAME-TENANT: a wholly owned list still approves every period, tenant-scoped", async () => {
    const periods = [
      { id: OWNED_ID, userMembershipId: 5, currentApproverMembershipId: 1 },
      { id: 12, userMembershipId: 6, currentApproverMembershipId: 1 },
    ];
    const { bulk, rec } = build([{ id: OWNED_ID }, { id: 12 }], [
      periods,
      [{ id: 1, orgId: ORG_ATTACKER, userId: "u1", role: "MEMBER", isOwner: false, status: "ACTIVE" }],
      [{ id: "person-1" }],
      [],
      [],
    ]);
    await expect(bulk.bulkApprove(actor, { periodIds: [OWNED_ID, 12] })).resolves.toEqual({
      approved: 2,
      skipped: 0,
    });

    const dialect = new PgDialect();
    const writes = rec.updateWhere.map((where) => dialect.sqlToQuery(where as SQL));
    expect(writes.length).toBe(2);
    for (const write of writes) {
      expect(write.params).toContain(ORG_ATTACKER);
      expect(write.sql).toContain("org_id");
      expect(write.params).toEqual(expect.arrayContaining([OWNED_ID, 12]));
    }
  });
});
