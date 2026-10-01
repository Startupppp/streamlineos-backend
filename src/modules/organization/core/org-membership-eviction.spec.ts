import { getTableName } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { SessionsService } from "../../sessions/sessions.service";
import { EmailService } from "../../email/email.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrgMembershipStatusService } from "./org-membership-status.service";
import { OrgMemberDepartureService } from "./org-member-departure.service";
import { OrgMembershipReadService } from "./org-membership-read.service";
import { AblyService } from "../../realtime/ably.service";

let otherActiveMemberships: unknown[] = [{ n: 1 }];

jest.mock("../../../common/tenant/with-identity", () => ({
  withIdentity: jest.fn(
    (_db: unknown, _userId: string, fn: (tx: unknown) => unknown) => {
      const rows = otherActiveMemberships;
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
        chain[method] = () => chain;
      }
      chain.then = (resolve: (value: unknown) => unknown) => resolve(rows);
      return Promise.resolve(fn(chain));
    },
  ),
}));

describe("OrgMembershipService access revocation", () => {
  async function evict() {
    const where = jest.fn().mockReturnValue(
      Object.assign(Promise.resolve(undefined), {
        returning: jest.fn().mockResolvedValue([]),
      }),
    );
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const revokeAllForUser = jest.fn();
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const selectChain: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy", "limit"]) {
      selectChain[method] = () => selectChain;
    }
    selectChain.then = (resolve: (value: unknown) => unknown) =>
      resolve([{ id: 7 }]);
    const tx = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockReturnValue(selectChain),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue(
          Object.assign(Promise.resolve(undefined), {
            onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
          }),
        ),
      }),
      query: { users: { findFirst: jest.fn().mockResolvedValue({ email: "member@example.com" }) } },
      update,
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgMembershipService,
        { provide: OrgMembershipStatusService, useValue: {} },
        { provide: OrgMemberDepartureService, useValue: {} },
        { provide: AblyService, useValue: { revokeUserTokens: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: EmailService,
          useValue: {
            sendMembershipRemovedEmail: jest.fn().mockResolvedValue(undefined),
            sendMembershipSuspendedEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: DRIZZLE,
          useValue: {
            query: { users: { findFirst: jest.fn().mockResolvedValue({ email: "member@example.com" }) } },
            transaction: jest
              .fn()
              .mockImplementation(
                (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
              ),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: { invalidate, invalidateNamespace: jest.fn() },
        },
        { provide: SessionsService, useValue: { revokeAllForUser, publishRevocations: jest.fn() } },
        { provide: AccessService, useValue: {} },
        { provide: OrgMembershipReadService, useValue: {} },
      ],
    }).compile();
    const service = moduleRef.get(OrgMembershipService);

    await service.revokeOrgScopedAccess("org-1", "member-1", "removed");

    const updatedTables = update.mock.calls.map((call) =>
      getTableName(call[0] as Parameters<typeof getTableName>[0]),
    );
    return { updatedTables, revokeAllForUser, invalidate };
  }

  afterEach(() => {
    otherActiveMemberships = [{ n: 1 }];
  });

  it("evicts only the requested organization without revoking account sessions", async () => {
    const { updatedTables, revokeAllForUser, invalidate } = await evict();

    expect(updatedTables).toEqual(
      expect.arrayContaining([
        "agent_tokens",
        "user_delegations",
        "ownership_transfers",
      ]),
    );
    expect(updatedTables).not.toContain("user_sessions");
    expect(revokeAllForUser).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith("user:session:member-1");
  });

  it("ends the identity on the same transaction when the member has no other active organisation, never through a pre-commit Redis call", async () => {
    otherActiveMemberships = [];

    const { updatedTables, revokeAllForUser } = await evict();

    expect(updatedTables).toEqual(expect.arrayContaining(["agent_tokens", "user_sessions"]));
    expect(revokeAllForUser).not.toHaveBeenCalled();
  });
});
