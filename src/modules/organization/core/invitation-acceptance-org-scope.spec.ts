jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import { Test } from "@nestjs/testing";
import { InvitationAcceptanceService } from "./invitation-acceptance.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { EmailService } from "../../email/email.service";
import { hashToken } from "../../../common/security/token.util";
import {
  invitationEmailOtps,
  invitations,
  magicLinkTokens,
  organizationAllowedEmailDomains,
  organizationMembers,
  users,
} from "../../../db/schema";

const ORG_ID = "org-accept-scope";
const OTHER_ORG_ID = "org-accept-other";
const RAW_TOKEN = "f".repeat(64);
const VALID_OTP = "123456";
const TOKEN_HASH = hashToken(RAW_TOKEN);
const INVITED_EMAIL = "joiner@scope.test";

const PENDING_INVITATION = {
  id: "inv-scope-1",
  email: INVITED_EMAIL,
  orgId: ORG_ID,
  role: "MEMBER",
  tokenHash: TOKEN_HASH,
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  status: "PENDING",
  inviterMembershipId: null,
};

const ACTIVE_ORG = {
  name: "Scope Org",
  slug: "scope-org",
  region: "primary",
  status: "ACTIVE",
  deletedAt: null,
};

type RecordedInsert = { table: unknown; values: unknown };

function buildHarness(orgId: string = ORG_ID) {
  const inserts: RecordedInsert[] = [];

  const invitation = { ...PENDING_INVITATION, orgId };
  const lockedInvitationRows = [invitation];
  const membershipRows = [{ id: 99 }];
  let selectedTable: unknown = null;

  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(null) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      organizations: { findFirst: jest.fn().mockResolvedValue(ACTIVE_ORG) },
      invitations: { findFirst: jest.fn().mockResolvedValue(invitation) },
      invitationEmailOtps: {
        findFirst: jest.fn().mockResolvedValue({
          id: 1,
          codeHash: hashToken(VALID_OTP),
          expiresAt: new Date(Date.now() + 600_000),
          usedAt: null,
          attempts: 0,
        }),
      },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockImplementation(function (this: unknown, table: unknown) {
      selectedTable = table;
      return this;
    }),
    where: jest.fn().mockImplementation(function (this: unknown) {
      return this;
    }),
    orderBy: jest.fn().mockImplementation(function (this: unknown) {
      return this;
    }),
    for: jest.fn().mockImplementation(function (this: unknown) {
      return this;
    }),
    limit: jest.fn().mockImplementation(() => {
      if (selectedTable === invitations) return Promise.resolve(lockedInvitationRows);
      if (selectedTable === organizationAllowedEmailDomains) return Promise.resolve([]);
      return Promise.resolve([]);
    }),
    update: jest.fn().mockImplementation((table: unknown) => ({
      set: (_values: unknown) => ({
        where: () => ({
          returning: () =>
            Promise.resolve(table === invitations ? [{ id: invitation.id }] : []),
          then: (resolve: (v: undefined) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        }),
      }),
    })),
    insert: jest.fn().mockImplementation((table: unknown) => ({
      values: jest.fn((vals: unknown) => {
        inserts.push({ table, values: vals });
        const rows =
          table === organizationMembers
            ? membershipRows
            : table === users
              ? [{ id: "new-user-1" }]
              : [{ id: "row-1" }];
        return {
          returning: () => Promise.resolve(rows),
          onConflictDoNothing: function () { return this; },
          onConflictDoUpdate: function () { return this; },
          then: (resolve: (v: undefined) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve, reject),
        };
      }),
    })),
  };

  const db = {
    query: tx.query,
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue([]),
    }),
    update: jest.fn().mockImplementation((table: unknown) => ({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(
            table === invitationEmailOtps ? [{ attempts: 1 }] : [],
          ),
          then: (resolve: (value: undefined) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        }),
      }),
    })),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (handle: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
  };

  const cache = {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
  };

  return { db, cache, tx, inserts };
}

describe("InvitationAcceptanceService.accept — magic link token carries the invitation org", () => {
  let svc: InvitationAcceptanceService;
  let harness: ReturnType<typeof buildHarness>;

  async function buildFor(orgId: string) {
    const built = buildHarness(orgId);
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: built.db },
        {
          provide: PlanLimitsService,
          useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SeatLedgerService,
          useValue: { recordSeatEvent: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CacheService, useValue: built.cache },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EmailService,
          useValue: { sendEmailOtpEmail: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    return { harness: built, svc: moduleRef.get(InvitationAcceptanceService) };
  }

  beforeEach(async () => {
    harness = buildHarness();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationAcceptanceService,
        { provide: DRIZZLE, useValue: harness.db },
        {
          provide: PlanLimitsService,
          useValue: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SeatLedgerService,
          useValue: { recordSeatEvent: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CacheService, useValue: harness.cache },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EmailService,
          useValue: { sendEmailOtpEmail: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    svc = moduleRef.get(InvitationAcceptanceService);
  });

  it("stamps the invitation org onto the auto-login token so the link cannot redeem into a different org", async () => {
    const result = await svc.accept({ token: RAW_TOKEN, emailOtp: VALID_OTP });

    const magicLinkInsert = harness.inserts.find((op) => op.table === magicLinkTokens);
    expect(magicLinkInsert).toBeDefined();
    expect((magicLinkInsert!.values as Record<string, unknown>).orgId).toBe(ORG_ID);
    expect(result.ok).toBe(true);
  });

  it("follows the inviting tenant rather than a constant when a second org's invitation is accepted", async () => {
    const other = await buildFor(OTHER_ORG_ID);

    await other.svc.accept({ token: RAW_TOKEN, emailOtp: VALID_OTP });

    const magicLinkInsert = other.harness.inserts.find((op) => op.table === magicLinkTokens);
    expect((magicLinkInsert!.values as Record<string, unknown>).orgId).toBe(OTHER_ORG_ID);
  });

  it("returns an auto-login token alongside the org-stamped magic link", async () => {
    const result = await svc.accept({ token: RAW_TOKEN, emailOtp: VALID_OTP });

    expect(result.ok).toBe(true);
    expect(typeof result.autoLoginToken).toBe("string");
    expect(result.autoLoginToken).toHaveLength(64);
    const magicLinkInsert = harness.inserts.find((op) => op.table === magicLinkTokens);
    expect(magicLinkInsert).toBeDefined();
  });
});
