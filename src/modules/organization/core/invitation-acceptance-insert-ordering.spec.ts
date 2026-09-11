jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { Test } from "@nestjs/testing";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { hashToken } from "../../../common/security/token.util";

const ORG_ID = "org-order-test";
const RAW_TOKEN = "d".repeat(64);
const BASE_INVITATION = {
  id: "inv-order-1",
  email: "invitee@example.com",
  orgId: ORG_ID,
  role: "MEMBER",
  tokenHash: hashToken(RAW_TOKEN),
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  status: "PENDING",
};
const EXISTING_USER = { id: "user-existing", email: "invitee@example.com" };

function buildQuery() {
  return {
    users: { findFirst: jest.fn().mockResolvedValue(null) },
    organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
    organizations: {
      findFirst: jest.fn().mockResolvedValue({
        id: ORG_ID,
        name: "Acme",
        status: "ACTIVE",
        deletedAt: null,
        allowedEmailDomains: [],
      }),
    },
    invitations: { findFirst: jest.fn().mockResolvedValue(BASE_INVITATION) },
  };
}

function buildUniversalTx(query: ReturnType<typeof buildQuery>) {
  const updateResult = {
    returning: jest.fn().mockResolvedValue([{ id: BASE_INVITATION.id }]),
    then: (resolve: (value: undefined) => unknown) =>
      Promise.resolve(undefined).then(resolve),
  };
  return {
    execute: jest.fn().mockResolvedValue([]),
    query,
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockImplementation(function (this: unknown) {
      return this;
    }),
    for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([BASE_INVITATION]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(updateResult) }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
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
}

function buildMockDb() {
  const query = buildQuery();
  const universalTx = buildUniversalTx(query);
  return {
    universalTx,
    query,
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
    transaction: jest.fn().mockImplementation(
      (fn: (tx: typeof universalTx) => Promise<unknown>) => fn(universalTx),
    ),
  };
}

describe("InvitationAcceptanceService.accept — assert-before-insert ordering", () => {
  let svc: InvitationAcceptanceService;
  let mockDb: ReturnType<typeof buildMockDb>;
  let mockPlanLimits: { assertWithinLimit: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb = buildMockDb();
    mockDb.universalTx.limit.mockResolvedValue([BASE_INVITATION]);
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        {
          provide: SeatLedgerService,
          useValue: { recordSeatEvent: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    svc = module.get(InvitationAcceptanceService);
  });

  it("calls assertWithinLimit before the organizationMembers insert — existing user path", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);

    await svc.accept({ token: RAW_TOKEN });

    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledTimes(1);
    expect(mockDb.universalTx.insert).toHaveBeenCalled();
    expect(mockPlanLimits.assertWithinLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.universalTx.insert.mock.invocationCallOrder[0],
    );
  });

  it("calls assertWithinLimit before the organizationMembers insert — new user path", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(null);

    await svc.accept({ token: RAW_TOKEN, firstName: "Jane", lastName: "Doe" });

    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledTimes(1);
    expect(mockDb.universalTx.insert).toHaveBeenCalled();
    expect(mockPlanLimits.assertWithinLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.universalTx.insert.mock.invocationCallOrder[0],
    );
  });

  it("passes the transaction executor to assertWithinLimit — existing user path", async () => {
    mockDb.query.invitations.findFirst.mockResolvedValue(BASE_INVITATION);
    mockDb.query.users.findFirst.mockResolvedValue(EXISTING_USER);
    mockDb.query.organizationMembers.findFirst.mockResolvedValue(null);

    await svc.accept({ token: RAW_TOKEN });

    const [orgArg, keyArg, , txArg] = mockPlanLimits.assertWithinLimit.mock.calls[0];
    expect(orgArg).toBe(ORG_ID);
    expect(keyArg).toBe("members");
    expect(txArg).toBe(mockDb.universalTx);
  });
});
