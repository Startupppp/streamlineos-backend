import { Test } from "@nestjs/testing";
import { OrgMembershipService } from "./org-membership.service";
import { OrgMembershipStatusService } from "./org-membership-status.service";
import { OrgMemberDepartureService } from "./org-member-departure.service";
import { OrgMembershipReadService } from "./org-membership-read.service";
import { MEMBERSHIP_ARTIFACTS } from "./membership-artifacts";
import { AblyService } from "../../realtime/ably.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { SessionsService } from "../../sessions/sessions.service";
import { EmailService } from "../../email/email.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AccessService } from "../../access/access.service";
import {
  agentTokens,
  chatHuddleParticipants,
  chatMessages,
  chatReplyReminders,
  chatSavedMessages,
  invitationEvents,
  invitations,
  kbSpaceGrants,
  organizationMembers,
  organizations,
  ownershipTransfers,
  resourceGrants,
  userDelegations,
  userIntegrationConnections,
} from "../../../db/schema";

jest.mock("../../../common/tenant/run-in-tenant-transaction");
jest.mock("../../../common/tenant/tenant-context");
jest.mock("../../../common/tenant/with-identity");
jest.mock("../../../common/outbox/outbox-writer");
jest.mock("../../../common/auth/membership-state.service");

import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import {
  registerAfterCommit,
  runOutsideTenantContext,
} from "../../../common/tenant/tenant-context";
import { withIdentity } from "../../../common/tenant/with-identity";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";

const mockRunInTenantTransaction = runInTenantTransaction as jest.MockedFunction<
  typeof runInTenantTransaction
>;
const mockRunOutsideTenantContext =
  runOutsideTenantContext as jest.MockedFunction<typeof runOutsideTenantContext>;
const mockWithIdentity = withIdentity as jest.MockedFunction<typeof withIdentity>;
const mockRegisterAfterCommit = registerAfterCommit as jest.MockedFunction<
  typeof registerAfterCommit
>;
const mockBustMembershipStatusCache =
  bustMembershipStatusCache as jest.MockedFunction<typeof bustMembershipStatusCache>;
const mockOutboxWriterEmitMany = OutboxWriter.emitMany as jest.MockedFunction<
  typeof OutboxWriter.emitMany
>;

const ORG_ID = "org-abc";
const USER_ID = "user-xyz";
const MEMBERSHIP_ID = 77;
const USER_EMAIL = "member@example.com";

function buildTx(opts: {
  membershipFound?: boolean;
  revokedInviteIds?: string[];
  connRows?: Array<{ id: number; composioConnectedAccountId: string }>;
} = {}) {
  const {
    membershipFound = true,
    revokedInviteIds = [],
    connRows = [],
  } = opts;

  const membershipRow = membershipFound ? [{ id: MEMBERSHIP_ID }] : [];

  const limitFn = jest.fn().mockResolvedValue(membershipRow);
  const selectWhereFn = jest.fn().mockReturnValue({ limit: limitFn });
  const fromFn = jest.fn().mockReturnValue({ where: selectWhereFn });
  const selectFn = jest.fn().mockReturnValue({ from: fromFn });

  const inviteReturningFn = jest.fn().mockResolvedValue(
    revokedInviteIds.map((id) => ({ id })),
  );
  const connReturningFn = jest.fn().mockResolvedValue(connRows);
  const noOpReturningFn = jest.fn().mockResolvedValue([]);

  const updateFn = jest.fn().mockImplementation((table: unknown) => {
    const returningFn =
      table === invitations
        ? inviteReturningFn
        : table === userIntegrationConnections
          ? connReturningFn
          : noOpReturningFn;
    const whereFn = jest.fn().mockReturnValue({ returning: returningFn });
    const setFn = jest.fn().mockReturnValue({ where: whereFn });
    return { set: setFn };
  });

  const deleteWhereFn = jest.fn().mockResolvedValue(undefined);
  const deleteFn = jest.fn().mockReturnValue({ where: deleteWhereFn });

  const insertValuesFn = jest.fn().mockResolvedValue(undefined);
  const insertFn = jest.fn().mockReturnValue({ values: insertValuesFn });

  return {
    tx: { select: selectFn, update: updateFn, delete: deleteFn, insert: insertFn },
    updateFn,
    deleteFn,
    insertFn,
    inviteReturningFn,
    connReturningFn,
  };
}

async function buildService(opts: {
  otherActiveMemberships?: number;
} = {}) {
  const { otherActiveMemberships = 0 } = opts;

  const mockCacheInvalidate = jest.fn().mockResolvedValue(undefined);

  const mockDb = {
    query: {
      users: {
        findFirst: jest.fn().mockResolvedValue({ email: USER_EMAIL }),
      },
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgMembershipService,
      { provide: OrgMembershipStatusService, useValue: {} },
      { provide: OrgMemberDepartureService, useValue: {} },
      { provide: AblyService, useValue: { revokeUserTokens: jest.fn().mockResolvedValue(undefined) } },
      { provide: AuditService, useValue: { log: jest.fn() } },
      {
        provide: CacheService,
        useValue: {
          invalidate: mockCacheInvalidate,
          invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          invalidateMany: jest.fn().mockResolvedValue(undefined),
          invalidateNamespaceMany: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: DRIZZLE, useValue: mockDb },
      { provide: SessionsService, useValue: { revokeAllForUser: jest.fn().mockResolvedValue(undefined) } },
      { provide: EmailService, useValue: {} },
      { provide: NotificationDispatchService, useValue: {} },
      { provide: AccessService, useValue: {} },
      { provide: OrgMembershipReadService, useValue: {} },
    ],
  }).compile();

  const service = moduleRef.get(OrgMembershipService);
  const sessions = moduleRef.get(SessionsService);
  const ably = moduleRef.get(AblyService);

  mockRunOutsideTenantContext.mockImplementation((fn) => fn());
  mockWithIdentity.mockImplementation((_db, _userId, fn) => {
    const countRow = [{ n: otherActiveMemberships }];
    const whereFn = jest.fn().mockResolvedValue(countRow);
    const innerJoinFn = jest.fn().mockReturnValue({ where: whereFn });
    const fromFn = jest.fn().mockReturnValue({ innerJoin: innerJoinFn });
    const selectFn = jest.fn().mockReturnValue({ from: fromFn });
    return fn({ select: selectFn } as unknown as Parameters<typeof fn>[0]);
  });

  mockBustMembershipStatusCache.mockResolvedValue(undefined);
  mockRegisterAfterCommit.mockImplementation((_fn) => true);

  return { service, sessions, ably, mockDb };
}

describe("OrgMembershipService.revokeOrgScopedAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOutboxWriterEmitMany.mockResolvedValue(undefined);
  });

  describe("removal: revokes all expected artifacts", () => {
    it("revokes agent tokens keyed by issuerMembershipId", async () => {
      const { tx, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(updateFn).toHaveBeenCalledWith(agentTokens);
    });

    it("revokes active delegations in both directions", async () => {
      const { tx, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(updateFn).toHaveBeenCalledWith(userDelegations);
    });

    it("cancels pending ownership transfers naming the membership in any role", async () => {
      const { tx, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(updateFn).toHaveBeenCalledWith(ownershipTransfers);
    });

    it("deletes resource grants for the user principal", async () => {
      const { tx, deleteFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(deleteFn).toHaveBeenCalledWith(resourceGrants);
    });

    it("deletes KB space grants for the user principal", async () => {
      const { tx, deleteFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(deleteFn).toHaveBeenCalledWith(kbSpaceGrants);
    });

    it("revokes pending invitations for the member's email and inserts event records", async () => {
      const { tx, updateFn, insertFn } = buildTx({ revokedInviteIds: ["inv-1"] });
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(updateFn).toHaveBeenCalledWith(invitations);
      expect(insertFn).toHaveBeenCalledWith(invitationEvents);
    });

    it("disables integration connections and emits an outbox event per connection", async () => {
      const conn = { id: 5, composioConnectedAccountId: "composio-abc" };
      const { tx, updateFn } = buildTx({ connRows: [conn] });
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(updateFn).toHaveBeenCalledWith(userIntegrationConnections);
      // One statement carrying one event per disabled connection, not one INSERT each.
      expect(mockOutboxWriterEmitMany).toHaveBeenCalledWith(
        tx,
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "integration.connection.disconnected",
            payload: expect.objectContaining({
              composioConnectedAccountId: conn.composioConnectedAccountId,
              cause: "removed",
            }),
          }),
        ]),
      );
    });

    it("provider disconnect goes to the outbox, not called inline", async () => {
      const conn = { id: 6, composioConnectedAccountId: "composio-xyz" };
      const { tx } = buildTx({ connRows: [conn] });
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(mockOutboxWriterEmitMany).toHaveBeenCalled();
    });

    it("schedules realtime revocation post-commit via registerAfterCommit", async () => {
      const { tx } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(mockRegisterAfterCommit).toHaveBeenCalled();
    });

    it("withdraws the realtime capability inline when there is no ambient transaction to defer to", async () => {
      const { tx } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service, ably } = await buildService();
      mockRegisterAfterCommit.mockImplementation(() => false);

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(ably.revokeUserTokens).toHaveBeenCalledWith(USER_ID);
    });

    it("does not insert invitationEvents when no invitations are pending", async () => {
      const { tx, insertFn } = buildTx({ revokedInviteIds: [] });
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(insertFn).not.toHaveBeenCalledWith(invitationEvents);
    });
  });

  describe("suspension: revokes credentials but retains grant-level artifacts", () => {
    it("revokes agent tokens on suspension", async () => {
      const { tx, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(updateFn).toHaveBeenCalledWith(agentTokens);
    });

    it("revokes active delegations in both directions on suspension", async () => {
      const { tx, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(updateFn).toHaveBeenCalledWith(userDelegations);
    });

    it("cancels pending ownership transfers on suspension", async () => {
      const { tx, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(updateFn).toHaveBeenCalledWith(ownershipTransfers);
    });

    it("does NOT delete resource grants on suspension (retention is reversible)", async () => {
      const { tx, deleteFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(deleteFn).not.toHaveBeenCalledWith(resourceGrants);
    });

    it("does NOT delete KB space grants on suspension", async () => {
      const { tx, deleteFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(deleteFn).not.toHaveBeenCalledWith(kbSpaceGrants);
    });

    it("does NOT revoke pending invitations on suspension", async () => {
      const { tx, updateFn } = buildTx({ revokedInviteIds: ["inv-1"] });
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(updateFn).not.toHaveBeenCalledWith(invitations);
    });

    it("disables integration connections on suspension", async () => {
      const { tx, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(updateFn).toHaveBeenCalledWith(userIntegrationConnections);
    });
  });

  describe("RT-006 regression: realtime revocation on suspension", () => {
    it("schedules Ably token revocation via registerAfterCommit on suspension (not only on removal)", async () => {
      const { tx } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(mockRegisterAfterCommit).toHaveBeenCalled();
    });
  });

  describe("session revocation: conditional on last active membership", () => {
    it("revokes sessions when this is the last active membership across all orgs", async () => {
      const { tx } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service, sessions } = await buildService({ otherActiveMemberships: 0 });

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
    });

    it("does NOT revoke sessions when another active membership in a different org exists", async () => {
      const { tx } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service, sessions } = await buildService({ otherActiveMemberships: 1 });

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });

    it("also revokes sessions on suspension when it was the last active membership", async () => {
      const { tx } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service, sessions } = await buildService({ otherActiveMemberships: 0 });

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
    });

    it("does NOT revoke sessions on suspension when another org membership is active", async () => {
      const { tx } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service, sessions } = await buildService({ otherActiveMemberships: 1 });

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe("MEMBERSHIP_ARTIFACTS contract: inventory-driven assertions", () => {
    it("every database-write artifact with onSuspension=revoke is handled for the suspended cause", async () => {
      const revokeOnSuspensionIds = MEMBERSHIP_ARTIFACTS.filter(
        (a) => a.onSuspension === "revoke" && a.table !== null,
      ).map((a) => a.id);

      expect(revokeOnSuspensionIds).toEqual(
        expect.arrayContaining([
          "user_delegations",
          "agent_tokens",
          "ownership_transfers",
          "user_integration_connections",
        ]),
      );

      const { tx, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(updateFn).toHaveBeenCalledWith(agentTokens);
      expect(updateFn).toHaveBeenCalledWith(userDelegations);
      expect(updateFn).toHaveBeenCalledWith(ownershipTransfers);
      expect(updateFn).toHaveBeenCalledWith(userIntegrationConnections);
    });

    it("integration_connections (provider artifact) is disabled on every cause", async () => {
      const causes = ["removed", "suspended", "archived", "left"] as const;
      for (const cause of causes) {
        jest.clearAllMocks();
        const { tx, updateFn } = buildTx();
        mockRunInTenantTransaction.mockImplementation((_db, fn) =>
          fn(tx as unknown as Parameters<typeof fn>[0]),
        );
        const { service } = await buildService();

        await service.revokeOrgScopedAccess(ORG_ID, USER_ID, cause);

        expect(updateFn).toHaveBeenCalledWith(userIntegrationConnections);
      }
    });

    it("realtime_capability is revoked on every cause (registerAfterCommit called each time)", async () => {
      const causes = ["removed", "suspended", "archived", "left"] as const;
      for (const cause of causes) {
        jest.clearAllMocks();
        const { tx } = buildTx();
        mockRunInTenantTransaction.mockImplementation((_db, fn) =>
          fn(tx as unknown as Parameters<typeof fn>[0]),
        );
        const { service } = await buildService();

        await service.revokeOrgScopedAccess(ORG_ID, USER_ID, cause);

        expect(mockRegisterAfterCommit).toHaveBeenCalled();
      }
    });
  });

  describe("no-op when membership was already deleted (removed/left scenario)", () => {
    it("skips membership-id-dependent operations when membership is not found", async () => {
      const { tx, updateFn } = buildTx({ membershipFound: false });
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(updateFn).not.toHaveBeenCalledWith(agentTokens);
      expect(updateFn).not.toHaveBeenCalledWith(userDelegations);
      expect(updateFn).not.toHaveBeenCalledWith(ownershipTransfers);
    });

    it("still cleans up resource grants and integration connections by userId even without membership", async () => {
      const { tx, updateFn, deleteFn } = buildTx({ membershipFound: false });
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(deleteFn).toHaveBeenCalledWith(resourceGrants);
      expect(deleteFn).toHaveBeenCalledWith(kbSpaceGrants);
      expect(updateFn).toHaveBeenCalledWith(userIntegrationConnections);
    });
  });

  describe("access caches are busted immediately and post-commit", () => {
    it("busts cache immediately before the tenant transaction", async () => {
      const { tx } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service, mockDb } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(mockBustMembershipStatusCache).toHaveBeenCalled();
    });

    it("registers a post-commit re-bust via registerAfterCommit", async () => {
      const { tx } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(mockRegisterAfterCommit).toHaveBeenCalledTimes(2);
    });
  });

  describe("chat session artifact cleanup on removal (no-FK tables)", () => {
    it("nulls sender_membership_id on chat_messages authored by the removed user", async () => {
      const { tx, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(updateFn).toHaveBeenCalledWith(chatMessages);
    });

    it("deletes chat_saved_messages for the removed user in the org", async () => {
      const { tx, deleteFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(deleteFn).toHaveBeenCalledWith(chatSavedMessages);
    });

    it("deletes chat_reply_reminders where the removed user is recipient or sender", async () => {
      const { tx, deleteFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(deleteFn).toHaveBeenCalledWith(chatReplyReminders);
    });

    it("deletes chat_huddle_participants for the removed user", async () => {
      const { tx, deleteFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(deleteFn).toHaveBeenCalledWith(chatHuddleParticipants);
    });

    it("does NOT touch chat session artifacts on suspension (retention is reversible)", async () => {
      const { tx, deleteFn, updateFn } = buildTx();
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "suspended");

      expect(deleteFn).not.toHaveBeenCalledWith(chatSavedMessages);
      expect(deleteFn).not.toHaveBeenCalledWith(chatReplyReminders);
      expect(deleteFn).not.toHaveBeenCalledWith(chatHuddleParticipants);
      expect(updateFn).not.toHaveBeenCalledWith(chatMessages);
    });

    it("still cleans up chat session artifacts when membership row was already deleted before revocation runs", async () => {
      const { tx, deleteFn, updateFn } = buildTx({ membershipFound: false });
      mockRunInTenantTransaction.mockImplementation((_db, fn) => fn(tx as unknown as Parameters<typeof fn>[0]));
      const { service } = await buildService();

      await service.revokeOrgScopedAccess(ORG_ID, USER_ID, "removed");

      expect(updateFn).toHaveBeenCalledWith(chatMessages);
      expect(deleteFn).toHaveBeenCalledWith(chatSavedMessages);
      expect(deleteFn).toHaveBeenCalledWith(chatReplyReminders);
      expect(deleteFn).toHaveBeenCalledWith(chatHuddleParticipants);
    });
  });
});
