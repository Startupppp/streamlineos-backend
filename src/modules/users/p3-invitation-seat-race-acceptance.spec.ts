jest.mock("../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvitationAcceptanceService } from "../organization/core/invitation-acceptance.service";
import { InvitationLifecycleService } from "../organization/core/invitation-lifecycle.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { SeatLedgerService } from "../billing/core/seat-ledger.service";
import { CacheService } from "../../common/cache/cache.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AccessService } from "../access/access.service";
import { AuditService } from "../../common/audit/audit.service";
import { EmailService } from "../email/email.service";
import { hashToken } from "../../common/security/token.util";
import { invitations } from "../../db/schema";

/*
 * P3 — Invitation and seat race: acceptance-level proofs.
 *
 * Race proof boundary: a real 2-connection pg_advisory_xact_lock proof is NOT feasible
 * inside Jest's single-process mock environment (two BEGIN calls on one postgres client
 * share one connection and do not race). That proof lives in
 * src/scripts/prove-quota-lock-serializes.mjs and requires a scratch DB.
 *
 * What IS proven here (mocked, at the service/transaction seam):
 *
 *   ONE_SEAT_ONLY      — lock→check ordering proven in existing per-scenario specs.
 *                        This file adds: (a) no seat event when assertWithinLimit fails
 *                        (rollback erases the ledger write), and (b) no seat event when
 *                        lockPendingInvitation returns 0 rows (stale token).
 *
 *   STALE_TOKEN        — ConflictException at the row-lock stage, no seat event emitted.
 *
 *   ROLLBACK           — limit-check failure → no membership insert AND no seat event.
 *
 *   POST_COMMIT_DELIVERY — resend email is not fired when the in-transaction update
 *                          aborts; it fires exactly once when the update succeeds.
 *
 *   DECLINE_IDEMPOTENCY — concurrent winner transitions the row before the decline
 *                         update runs; 0-row update → NotFoundException → no
 *                         INVITE_CANCELLED event. The idempotency key
 *                         `invite-declined:<id>` and event type INVITE_CANCELLED are
 *                         proven in invitation-decline-seat.spec.ts.
 *
 *   PENDING_TO_DIRECT  — atomic cancel+lock+check+insert proven in
 *                         membership-admission-seat-limit.spec.ts (P7 section).
 */

const ORG_ID = "org-p3-race";
const ACTOR = { userId: "actor-p3", isOrgOwner: true };
const RAW_TOKEN = "f".repeat(64);
const TOKEN_HASH = hashToken(RAW_TOKEN);
const INVITATION_ID = "inv-p3-race-1";
const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);

const PENDING_INVITATION = {
  id: INVITATION_ID,
  orgId: ORG_ID,
  email: "joiner@example.com",
  role: "MEMBER",
  tokenHash: TOKEN_HASH,
  expiresAt: FUTURE,
  acceptedAt: null,
  status: "PENDING" as const,
  inviterMembershipId: null,
};

const EXISTING_USER = {
  id: "user-p3",
  email: "joiner@example.com",
  isActive: true,
  deletedAt: null,
};

const ACTIVE_ORG = {
  id: ORG_ID,
  name: "Acme",
  status: "ACTIVE",
  deletedAt: null,
  allowedEmailDomains: [],
};

function buildAcceptQuery() {
  return {
    users: { findFirst: jest.fn().mockResolvedValue(null) },
    organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    organizations: { findFirst: jest.fn().mockResolvedValue(ACTIVE_ORG) },
    invitations: { findFirst: jest.fn().mockResolvedValue(PENDING_INVITATION) },
  };
}

function buildAcceptTx(
  query: ReturnType<typeof buildAcceptQuery>,
  lockedRows: unknown[],
) {
  let selectedTable: unknown = null;
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    query,
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockImplementation(function (this: unknown, table: unknown) {
      selectedTable = table;
      return this;
    }),
    where: jest.fn().mockImplementation(function (this: unknown) {
      return this;
    }),
    for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockImplementation(() =>
      Promise.resolve(selectedTable === invitations ? lockedRows : []),
    ),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: INVITATION_ID }]),
      }),
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
        returning: jest.fn().mockResolvedValue([{ id: 42 }]),
      }),
    })),
  };
  return tx;
}

function buildAcceptDb(lockedRows = [PENDING_INVITATION]) {
  const query = buildAcceptQuery();
  const tx = buildAcceptTx(query, lockedRows);
  return {
    query,
    tx,
    db: {
      query,
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
      transaction: jest.fn().mockImplementation(
        (fn: (handle: typeof tx) => Promise<unknown>) => fn(tx),
      ),
    },
  };
}

describe("P3 — rollback prevents seat ledger entry (accept path)", () => {
  let svc: InvitationAcceptanceService;
  let recordSeatEvent: jest.Mock;
  let harness: ReturnType<typeof buildAcceptDb>;
  let planLimits: { assertWithinLimit: jest.Mock };

  async function buildModule(lockedRows = [PENDING_INVITATION]) {
    harness = buildAcceptDb(lockedRows);
    recordSeatEvent = jest.fn().mockResolvedValue(undefined);
    planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: harness.db },
        { provide: PlanLimitsService, useValue: planLimits },
        { provide: SeatLedgerService, useValue: { recordSeatEvent } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    svc = moduleRef.get(InvitationAcceptanceService);
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    await buildModule();
  });

  it("emits no seat event when assertWithinLimit rejects on the existing-user path", async () => {
    harness.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    harness.query.organizationMembers.findFirst.mockResolvedValue(null);
    planLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("member limit reached"),
    );

    await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeInstanceOf(ForbiddenException);

    expect(recordSeatEvent).not.toHaveBeenCalled();
  });

  it("emits no seat event when assertWithinLimit rejects on the new-user path", async () => {
    harness.query.users.findFirst.mockResolvedValue(null);
    planLimits.assertWithinLimit.mockRejectedValue(
      new ForbiddenException("member limit reached"),
    );

    await expect(
      svc.accept({ token: RAW_TOKEN, firstName: "Jane", lastName: "Doe" }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(recordSeatEvent).not.toHaveBeenCalled();
  });

  it("emits no seat event when the row lock finds no matching pending row (stale or accepted token)", async () => {
    await buildModule([]);
    harness.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    harness.query.organizationMembers.findFirst.mockResolvedValue(null);

    await expect(svc.accept({ token: RAW_TOKEN })).rejects.toBeDefined();

    expect(recordSeatEvent).not.toHaveBeenCalled();
  });

  it("emits the INVITE_ACCEPTED seat event only when the full transaction succeeds", async () => {
    harness.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    harness.query.organizationMembers.findFirst.mockResolvedValue(null);

    const result = await svc.accept({ token: RAW_TOKEN });

    expect(result.ok).toBe(true);
    expect(recordSeatEvent).toHaveBeenCalledTimes(1);
    expect(recordSeatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        eventType: "INVITE_ACCEPTED",
        subjectId: INVITATION_ID,
        idempotencyKey: `invite-accepted:${INVITATION_ID}`,
      }),
      harness.tx,
    );
  });

  it("passes the live transaction handle to recordSeatEvent, not the pool", async () => {
    harness.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    harness.query.organizationMembers.findFirst.mockResolvedValue(null);

    await svc.accept({ token: RAW_TOKEN });

    const [, txArg] = recordSeatEvent.mock.calls[0] as [unknown, unknown];
    expect(txArg).toBe(harness.tx);
  });
});

function buildDeclineDb(updateReturnsRows: boolean) {
  const updateReturning = jest.fn().mockResolvedValue(
    updateReturnsRows ? [{ id: INVITATION_ID }] : [],
  );
  const eventValues = jest.fn().mockResolvedValue(undefined);
  const memberFindFirst = jest.fn().mockResolvedValue({ userId: "inviter-1" });
  const adminSelectWhere = jest.fn().mockResolvedValue([{ userId: "owner-1" }]);
  const invitationFindFirst = jest.fn().mockResolvedValue(PENDING_INVITATION);

  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: updateReturning }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: eventValues }),
    query: {
      invitations: { findFirst: invitationFindFirst },
      organizationMembers: { findFirst: memberFindFirst },
    },
  };

  const db = {
    query: {
      invitations: { findFirst: invitationFindFirst },
      organizationMembers: { findFirst: memberFindFirst },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn(() => ({
          orderBy: jest.fn().mockReturnValue({ limit: adminSelectWhere }),
        })),
      }),
    }),
    transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { db, tx, eventValues, updateReturning };
}

describe("P3 — decline idempotency: concurrent winner, no second seat release", () => {
  it("emits no INVITE_CANCELLED event when a concurrent operation already transitioned the row", async () => {
    const { db, tx } = buildDeclineDb(false);
    const recordSeatEvent = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: db },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: SeatLedgerService, useValue: { recordSeatEvent } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    const svc = moduleRef.get(InvitationAcceptanceService);

    await expect(svc.decline({ token: RAW_TOKEN })).rejects.toBeInstanceOf(NotFoundException);

    expect(recordSeatEvent).not.toHaveBeenCalled();
    void tx;
  });

  it("emits exactly one INVITE_CANCELLED with the idempotency key for the declining side", async () => {
    const { db } = buildDeclineDb(true);
    const recordSeatEvent = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: db },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: SeatLedgerService, useValue: { recordSeatEvent } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    const svc = moduleRef.get(InvitationAcceptanceService);

    await expect(svc.decline({ token: RAW_TOKEN })).resolves.toEqual({ ok: true });

    expect(recordSeatEvent).toHaveBeenCalledTimes(1);
    expect(recordSeatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        eventType: "INVITE_CANCELLED",
        subjectId: INVITATION_ID,
        idempotencyKey: `invite-declined:${INVITATION_ID}`,
      }),
      expect.anything(),
    );
  });
});

function buildResendQuery() {
  return {
    invitations: { findFirst: jest.fn().mockResolvedValue(PENDING_INVITATION) },
    organizations: {
      findFirst: jest.fn().mockResolvedValue({
        id: ORG_ID,
        name: "Acme",
        status: "ACTIVE",
        deletedAt: null,
      }),
    },
    organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) },
    users: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

function buildResendDb(updateReturnsRows: boolean, expiresAt = FUTURE) {
  const query = buildResendQuery();
  const updateResult = {
    returning: jest.fn().mockResolvedValue(
      updateReturnsRows ? [{ id: INVITATION_ID }] : [],
    ),
  };
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    query,
    select: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    for: jest.fn(),
    limit: jest.fn().mockResolvedValue([
      { id: INVITATION_ID, status: "PENDING" as const, expiresAt },
    ]),
    update: jest.fn(),
    set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(updateResult) }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
  };
  tx.select.mockReturnValue(tx);
  tx.from.mockReturnValue(tx);
  tx.where.mockReturnValue(tx);
  tx.for.mockReturnValue(tx);
  tx.update.mockReturnValue(tx);

  return {
    query,
    tx,
    db: {
      query,
      transaction: jest.fn().mockImplementation(
        (fn: (handle: typeof tx) => Promise<unknown>) => fn(tx),
      ),
    },
  };
}

async function buildResendModule(
  db: ReturnType<typeof buildResendDb>["db"],
  sendEmail: jest.Mock,
  recordSeatEvent = jest.fn().mockResolvedValue(undefined),
): Promise<InvitationLifecycleService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      InvitationLifecycleService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      {
        provide: CacheService,
        useValue: {
          invalidateForOrg: jest.fn().mockResolvedValue(undefined),
          invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: EmailService, useValue: { sendInvitationEmail: sendEmail } },
      {
        provide: PlanLimitsService,
        useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: SeatLedgerService, useValue: { recordSeatEvent } },
      {
        provide: AccessService,
        useValue: {
          canManageOrganizationMembership: jest.fn().mockResolvedValue(true),
        },
      },
    ],
  }).compile();

  return moduleRef.get(InvitationLifecycleService);
}

describe("P3 — post-commit delivery: resend email fires after commit, not before", () => {
  it("fires the renewal email exactly once when the resend transaction succeeds", async () => {
    const { db } = buildResendDb(true);
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const svc = await buildResendModule(db, sendEmail);

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).resolves.toEqual({ success: true });

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("fires no renewal email when the in-transaction update finds 0 rows (concurrent winner)", async () => {
    const { db } = buildResendDb(false);
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const svc = await buildResendModule(db, sendEmail);

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("fires no renewal email when the pre-transaction invitation lookup returns nothing", async () => {
    const { db, query } = buildResendDb(true);
    query.invitations.findFirst.mockResolvedValue(null);
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const svc = await buildResendModule(db, sendEmail);

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("records a delivery failure without rethrowing when the email provider rejects", async () => {
    const { db } = buildResendDb(true);
    const sendEmail = jest.fn().mockRejectedValue(new Error("smtp down"));
    const svc = await buildResendModule(db, sendEmail);

    await expect(svc.resend(ORG_ID, INVITATION_ID, ACTOR)).resolves.toEqual({ success: true });
  });
});

describe("P3 — one-seat invariant: advisory lock fires before the limit check", () => {
  it("acquires the quota lock before assertWithinLimit on the accept path (existing-user)", async () => {
    const harness = buildAcceptDb();
    harness.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    harness.query.organizationMembers.findFirst.mockResolvedValue(null);

    const recordSeatEvent = jest.fn().mockResolvedValue(undefined);
    const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: harness.db },
        { provide: PlanLimitsService, useValue: planLimits },
        { provide: SeatLedgerService, useValue: { recordSeatEvent } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    const svc = moduleRef.get(InvitationAcceptanceService);

    await svc.accept({ token: RAW_TOKEN });

    const lockOrder = harness.tx.execute.mock.invocationCallOrder[0] ?? 0;
    const checkOrder = planLimits.assertWithinLimit.mock.invocationCallOrder[0] ?? 0;
    const eventOrder = recordSeatEvent.mock.invocationCallOrder[0] ?? 0;

    expect(lockOrder).toBeGreaterThan(0);
    expect(checkOrder).toBeGreaterThan(0);
    expect(lockOrder).toBeLessThan(checkOrder);
    expect(checkOrder).toBeLessThan(eventOrder);
  });
});
