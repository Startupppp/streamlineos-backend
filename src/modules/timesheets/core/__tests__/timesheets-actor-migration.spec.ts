import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  assertOrganizationActor,
  OrganizationActorError,
} from "../../../../common/organization/organization-actor";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { ApprovalsService } from "../approvals.service";

jest.mock("../../../../common/organization/organization-actor", () => {
  const actual = jest.requireActual<typeof import("../../../../common/organization/organization-actor")>(
    "../../../../common/organization/organization-actor",
  );
  return { ...actual, assertOrganizationActor: jest.fn() };
});

const mockAssertActor = assertOrganizationActor as jest.MockedFunction<typeof assertOrganizationActor>;

const PERIOD_ID = 10;
const ORG_ID = "org-a";
const APPROVER_MEMBERSHIP_ID = 77;
const EMPLOYEE_MEMBERSHIP_ID = 42;

const SUBMITTED_PERIOD = {
  id: PERIOD_ID,
  orgId: ORG_ID,
  userMembershipId: EMPLOYEE_MEMBERSHIP_ID,
  status: "SUBMITTED",
  currentApproverMembershipId: null,
  periodStart: "2025-01-01",
  periodEnd: "2025-01-31",
  totalHours: "80.00",
  billableHours: "80.00",
  nonBillableHours: "0.00",
  submittedAt: new Date(),
  approvedAt: null,
  rejectedAt: null,
  lockedAt: null,
  rejectionReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const APPROVED_PERIOD = {
  ...SUBMITTED_PERIOD,
  status: "APPROVED",
  approvedByMembershipId: APPROVER_MEMBERSHIP_ID,
  userEmail: "emp@test.com",
  userName: "Employee User",
};

const DEFAULT_SETTINGS = { lockAfterApproval: false };

const EMPLOYEE_MEMBER = { id: EMPLOYEE_MEMBERSHIP_ID, userId: "employee-user" };

function makeDb(period: unknown, settings: unknown, postApprovalPeriod: unknown, owner: unknown = null) {
  const dbSelectSequence: unknown[][] = [
    period !== null ? [period] : [],
    settings !== null ? [settings] : [],
    owner !== null ? [owner] : [],
    postApprovalPeriod !== null ? [postApprovalPeriod] : [],
  ];
  let dbSelectIdx = 0;

  const dbLimit = jest.fn().mockImplementation(() => {
    const result = dbSelectSequence[dbSelectIdx] ?? [];
    dbSelectIdx++;
    return Promise.resolve(result);
  });
  const dbWhere = jest.fn().mockReturnValue({ limit: dbLimit });
  const dbLeftJoinWhere = jest.fn().mockReturnValue({ limit: dbLimit, orderBy: jest.fn().mockReturnValue({ limit: dbLimit }) });
  const dbLeftJoin: jest.Mock = jest.fn();
  dbLeftJoin.mockReturnValue({ where: dbLeftJoinWhere, leftJoin: dbLeftJoin });
  const dbFrom = jest.fn().mockReturnValue({ where: dbWhere, leftJoin: dbLeftJoin });
  const dbSelect = jest.fn().mockReturnValue({ from: dbFrom });

  const setCaptures: Record<string, unknown>[] = [];
  const txReturning = jest.fn().mockResolvedValue([
    {
      eventSeq: 1,
      userMembershipId: 12,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-07",
      status: "APPROVED",
      totalHours: "0",
      billableHours: "0",
      nonBillableHours: "0",
    },
  ]);
  const txWhere = jest.fn().mockReturnValue({ returning: txReturning });
  const txSet = jest.fn().mockImplementation((arg: Record<string, unknown>) => {
    setCaptures.push(arg);
    return { where: txWhere };
  });
  const txUpdate = jest.fn().mockReturnValue({ set: txSet });

  const txSelectLimit = jest.fn().mockResolvedValue([]);
  const txSelectWhere = jest.fn().mockImplementation(() =>
    Object.assign(Promise.resolve([] as unknown[]), { limit: txSelectLimit }),
  );
  const txSelectFrom = jest.fn().mockReturnValue({ where: txSelectWhere });
  const txSelect = jest.fn().mockReturnValue({ from: txSelectFrom });

  const txInsertValues = jest.fn().mockResolvedValue(undefined);
  const txInsert = jest.fn().mockReturnValue({ values: txInsertValues });

  type TxMock = { update: typeof txUpdate; select: typeof txSelect; insert: typeof txInsert };
  const tx: TxMock = { update: txUpdate, select: txSelect, insert: txInsert };
  const transaction = jest.fn().mockImplementation(async (fn: (tx: TxMock) => Promise<void>) => fn(tx));

  return {
    select: dbSelect,
    transaction,
    query: { timesheetSettings: { findFirst: jest.fn() } },
    _setCaptures: setCaptures,
    _transaction: transaction,
  };
}

const USER_CTX = {
  userId: "approver-user",
  orgId: ORG_ID,
  role: "MEMBER",
  isOrgOwner: true,
  sessionId: "s1",
  tokenScopes: null,
  principal: humanSessionPrincipal(APPROVER_MEMBERSHIP_ID, true),
};

const AUDIT_MOCK = { record: jest.fn().mockResolvedValue(undefined) };
const RATE_RESOLVER_MOCK = { resolveMany: jest.fn().mockResolvedValue([]) };

const NOTIFICATIONS_MOCK = { emit: jest.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  jest.resetAllMocks();
  AUDIT_MOCK.record.mockResolvedValue(undefined);
  RATE_RESOLVER_MOCK.resolveMany.mockResolvedValue([]);
  NOTIFICATIONS_MOCK.emit.mockResolvedValue(undefined);
});

describe("TimesheetsApprovalsService — actor resolution on period approval", () => {
  it("rejects a non-member approver: throws NotFoundException and does not open a transaction", async () => {
    const db = makeDb(SUBMITTED_PERIOD, DEFAULT_SETTINGS, null);
    mockAssertActor.mockRejectedValue(
      new OrganizationActorError(ORG_ID, { kind: "user", userId: "approver-user" }, "no-membership"),
    );
    const svc = new ApprovalsService(
      db as never,
      {} as never,
      AUDIT_MOCK as never,
      RATE_RESOLVER_MOCK as never,
      NOTIFICATIONS_MOCK as never,
    );

    await expect(svc.approvePeriod(USER_CTX, PERIOD_ID)).rejects.toThrow(NotFoundException);
    expect(db._transaction).not.toHaveBeenCalled();
  });

  it("rejects a SUSPENDED member: throws ForbiddenException and does not open a transaction", async () => {
    const db = makeDb(SUBMITTED_PERIOD, DEFAULT_SETTINGS, null);
    mockAssertActor.mockRejectedValue(
      new OrganizationActorError(ORG_ID, { kind: "user", userId: "approver-user" }, "membership-inactive"),
    );
    const svc = new ApprovalsService(
      db as never,
      {} as never,
      AUDIT_MOCK as never,
      RATE_RESOLVER_MOCK as never,
      NOTIFICATIONS_MOCK as never,
    );

    await expect(svc.approvePeriod(USER_CTX, PERIOD_ID)).rejects.toThrow(ForbiddenException);
    expect(db._transaction).not.toHaveBeenCalled();
  });

  it("rejects a different-org member: NotFoundException, not ForbiddenException", async () => {
    const db = makeDb(SUBMITTED_PERIOD, DEFAULT_SETTINGS, null);
    const err = new OrganizationActorError(
      ORG_ID,
      { kind: "user", userId: "approver-user" },
      "membership-in-another-organization",
    );
    mockAssertActor.mockRejectedValue(err);
    const svc = new ApprovalsService(
      db as never,
      {} as never,
      AUDIT_MOCK as never,
      RATE_RESOLVER_MOCK as never,
      NOTIFICATIONS_MOCK as never,
    );

    let caught: Error | null = null;
    try {
      await svc.approvePeriod(USER_CTX, PERIOD_ID);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(NotFoundException);
    expect(caught).not.toBeInstanceOf(ForbiddenException);
  });

  it("writes approved_by_membership_id for a valid org member", async () => {
    const db = makeDb(SUBMITTED_PERIOD, DEFAULT_SETTINGS, APPROVED_PERIOD, EMPLOYEE_MEMBER);
    mockAssertActor.mockResolvedValue({
      orgId: ORG_ID,
      membershipId: APPROVER_MEMBERSHIP_ID,
      userId: "approver-user",
      organizationPersonId: null,
      role: "MEMBER",
      isOwner: true,
      resolvedVia: "user" as const,
    });
    const svc = new ApprovalsService(
      db as never,
      {} as never,
      AUDIT_MOCK as never,
      RATE_RESOLVER_MOCK as never,
      NOTIFICATIONS_MOCK as never,
    );

    await svc.approvePeriod(USER_CTX, PERIOD_ID);

    expect(db._transaction).toHaveBeenCalled();
    const periodUpdate = db._setCaptures[0];
    expect(periodUpdate).toMatchObject({
      status: "APPROVED",
      approvedByMembershipId: APPROVER_MEMBERSHIP_ID,
    });
    const timesheetUpdate = db._setCaptures[1];
    expect(timesheetUpdate).toMatchObject({
      status: "APPROVED",
      approvedByMembershipId: APPROVER_MEMBERSHIP_ID,
    });
  });
});
