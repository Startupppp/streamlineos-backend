import { Test } from "@nestjs/testing";
import { AccessService } from "../access/access.service";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { SeatLedgerService } from "../billing/core/seat-ledger.service";
import { InvitationsService } from "../organization/core/invitations.service";
import { OrgMembershipService } from "../organization/core/org-membership.service";
import { UsersService } from "./users.service";
import { EmploymentFactsService } from "../directory/employment-facts.service";

const stubEmployment = {
  getFacts: jest.fn().mockResolvedValue({ managerUserId: null }),
  getFactsBatch: jest.fn().mockResolvedValue(new Map()),
};

describe("UsersService direct member creation", () => {
  it("checks the member seat limit before writing a direct-created member", async () => {
    const assertWithinLimit = jest.fn().mockRejectedValue(new Error("seat limit"));
    const db = {
      query: { users: { findFirst: jest.fn() } },
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(),
    };
    db.transaction.mockImplementation(
      async (work: (tx: typeof db) => Promise<unknown>) => work(db),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn() } },
        { provide: InvitationsService, useValue: { invite: jest.fn() } },
        { provide: AccessService, useValue: {} },
        { provide: OrgMembershipService, useValue: {} },
        { provide: PlanLimitsService, useValue: { assertWithinLimit } },
        { provide: SeatLedgerService, useValue: { recordSeatEvent: jest.fn() } },
        { provide: EmploymentFactsService, useValue: stubEmployment },
      ],
    }).compile();
    const service = moduleRef.get(UsersService);

    await expect(
      service.createUser(
        "org-1",
        {
          email: "new@example.com",
          role: "MEMBER",
          sendInvite: false,
        },
        { userId: "owner-1", isOrgOwner: true },
      ),
    ).rejects.toThrow("seat limit");

    expect(assertWithinLimit).toHaveBeenCalledWith(
      "org-1",
      "members",
      1,
      db,
    );
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("records a seat event in the same transaction as the membership write", async () => {
    const recordSeatEvent = jest.fn().mockResolvedValue(undefined);
    const insertedInto: unknown[] = [];
    const db = {
      query: { users: { findFirst: jest.fn().mockResolvedValue(undefined) } },
      execute: jest.fn().mockResolvedValue(undefined),
      transaction: jest.fn(),
      select: jest.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        const passthrough = () => chain;
        chain["from"] = passthrough;
        chain["where"] = passthrough;
        chain["innerJoin"] = passthrough;
        chain["leftJoin"] = passthrough;
        chain["orderBy"] = passthrough;
        chain["limit"] = () => Promise.resolve([]);
        chain["then"] = (resolve: (rows: unknown[]) => unknown) => resolve([]);
        return chain;
      }),
      update: jest.fn().mockImplementation(() => {
        const chain: Record<string, unknown> = {};
        chain["set"] = () => chain;
        chain["where"] = () => Promise.resolve([]);
        return chain;
      }),
      delete: jest.fn().mockImplementation(() => ({ where: () => Promise.resolve([]) })),
      insert: jest.fn().mockImplementation((table: unknown) => {
        insertedInto.push(table);
        const chain = {
          values: () => chain,
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([{ id: 1 }]),
          then: (resolve: (rows: unknown[]) => unknown) => resolve([{ id: 1 }]),
        };
        return chain;
      }),
    };
    db.transaction.mockImplementation(
      async (work: (tx: typeof db) => Promise<unknown>) => work(db),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn(),
            invalidateForOrg: jest.fn(),
            invalidateNamespace: jest.fn(),
            invalidateNamespaceForOrg: jest.fn(),
            invalidatePattern: jest.fn(),
            del: jest.fn(),
            get: jest.fn(),
            set: jest.fn(),
          },
        },
        { provide: InvitationsService, useValue: { invite: jest.fn() } },
        { provide: AccessService, useValue: {} },
        { provide: OrgMembershipService, useValue: {} },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: jest.fn() } },
        { provide: SeatLedgerService, useValue: { recordSeatEvent } },
        { provide: EmploymentFactsService, useValue: stubEmployment },
      ],
    }).compile();

    await moduleRef.get(UsersService).createUser(
      "org-1",
      { email: "new@example.com", role: "MEMBER", sendInvite: false },
      { userId: "owner-1", isOrgOwner: true },
    );

    expect(recordSeatEvent).toHaveBeenCalledTimes(1);
    const [event, executor] = recordSeatEvent.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(event).toMatchObject({ orgId: "org-1", eventType: "INVITE_ACCEPTED", actorId: "owner-1" });
    expect(event["idempotencyKey"]).toMatch(/^member-added:org-1:/);
    expect(executor).toBe(db);
  });
});
