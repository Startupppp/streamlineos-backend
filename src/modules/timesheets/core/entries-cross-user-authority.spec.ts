import { ForbiddenException } from "@nestjs/common";
import { EntriesService } from "./entries.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG = "org-1";
const OWNER_MEMBERSHIP = 11;
const OTHER_MEMBERSHIP = 77;
const ENTRY_ID = 5;

const SOMEONE_ELSES_ENTRY = {
  id: ENTRY_ID,
  orgId: ORG,
  userMembershipId: OWNER_MEMBERSHIP,
  date: "2026-09-09",
  hours: "4.00",
  status: "PENDING",
  payrollStatus: "UNPROCESSED",
  invoicingStatus: "UNINVOICED",
  voidedAt: null,
  lockedAt: null,
  submittedAt: null,
  ticketId: null,
  projectId: null,
};

function actor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "usr-manager",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: OTHER_MEMBERSHIP, isOrgOwner: false },
    ...overrides,
  } as CurrentUserContext;
}

function serviceOver(entry: Record<string, unknown> | undefined) {
  const transaction = jest.fn((body: (tx: unknown) => Promise<unknown>) =>
    body({
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    }),
  );
  const db = {
    query: { timesheets: { findFirst: () => Promise.resolve(entry) } },
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ total: "0" }]) }) }),
    transaction,
  } as unknown as Db;
  const audit = { record: () => Promise.resolve() };
  const reader = {};
  const periodService = {
    loadSettings: () => Promise.resolve(null),
    recomputePeriodTotals: () => Promise.resolve(undefined),
    syncTicketTimeSpent: () => Promise.resolve(undefined),
  };
  return {
    svc: new EntriesService(db, audit as never, reader as never, periodService as never),
    transaction,
  };
}

// TS-SEC-005: timesheets:approvals:manage grants "approve, reject, reopen and
// lock". It used to also unlock editing and voiding any member's entries.
describe("EntriesService — authority over another member's entry", () => {
  it("refuses an update from a non-owner who is not the org owner", async () => {
    const { svc, transaction } = serviceOver(SOMEONE_ELSES_ENTRY);

    await expect(svc.updateEntry(actor(), ENTRY_ID, { hours: 1 })).rejects.toThrow(
      ForbiddenException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a void from a non-owner who is not the org owner", async () => {
    const { svc, transaction } = serviceOver(SOMEONE_ELSES_ENTRY);

    await expect(
      svc.voidEntry(actor(), ENTRY_ID, { reason: "wrong day" }),
    ).rejects.toThrow(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("still lets the org owner void another member's entry", async () => {
    const { svc, transaction } = serviceOver(SOMEONE_ELSES_ENTRY);

    await svc.voidEntry(actor({ isOrgOwner: true }), ENTRY_ID, { reason: "wrong day" });

    expect(transaction).toHaveBeenCalled();
  });

  it("still lets a member void their own entry", async () => {
    const { svc, transaction } = serviceOver(SOMEONE_ELSES_ENTRY);

    await svc.voidEntry(
      actor({ principal: { kind: "human-session", membershipId: OWNER_MEMBERSHIP, isOrgOwner: false } }),
      ENTRY_ID,
      { reason: "wrong day" },
    );

    expect(transaction).toHaveBeenCalled();
  });
});
