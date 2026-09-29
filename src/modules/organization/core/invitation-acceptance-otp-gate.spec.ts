jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
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
  organizationAllowedEmailDomains,
  organizationMembers,
} from "../../../db/schema";

const ORG_ID = "org-otp-gate";
const RAW_TOKEN = "g".repeat(64);
const TOKEN_HASH = hashToken(RAW_TOKEN);
const INVITED_EMAIL = "new.member@otp.test";
const VALID_OTP = "123456";
const WRONG_OTP = "999999";

const PENDING_INVITATION = {
  id: "inv-otp-1",
  email: INVITED_EMAIL,
  orgId: ORG_ID,
  role: "MEMBER",
  tokenHash: TOKEN_HASH,
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  status: "PENDING",
  inviterMembershipId: null,
};

const VALID_OTP_ROW = {
  id: 1,
  codeHash: hashToken(VALID_OTP),
  expiresAt: new Date(Date.now() + 600_000),
  usedAt: null,
  attempts: 0,
};

const ACTIVE_ORG = {
  name: "OTP Org",
  slug: "otp-org",
  region: "primary",
  status: "ACTIVE",
  deletedAt: null,
};

function buildHarness() {
  const invitationFindFirst = jest.fn().mockResolvedValue(PENDING_INVITATION);
  const otpFindFirst = jest.fn().mockResolvedValue(VALID_OTP_ROW);
  let selectedTable: unknown = null;

  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    query: {
      users: { findFirst: jest.fn().mockResolvedValue(null) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      organizations: { findFirst: jest.fn().mockResolvedValue(ACTIVE_ORG) },
      invitations: { findFirst: invitationFindFirst },
      invitationEmailOtps: { findFirst: otpFindFirst },
    },
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockImplementation(function (this: unknown, table: unknown) {
      selectedTable = table;
      return this;
    }),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockImplementation(() =>
      Promise.resolve(
        selectedTable === invitations
          ? [PENDING_INVITATION]
          : selectedTable === organizationAllowedEmailDomains
            ? []
            : [],
      ),
    ),
    update: jest.fn().mockImplementation((table: unknown) => ({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(
            table === invitations ? [{ id: PENDING_INVITATION.id }] : [],
          ),
          then: (resolve: (v: undefined) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        }),
      }),
    })),
    insert: jest.fn().mockImplementation((table: unknown) => ({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(
          table === organizationMembers ? [{ id: 42 }] : [{ id: 1 }],
        ),
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
        onConflictDoUpdate: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
        then: (
          resolve: (v: undefined) => unknown,
          reject?: (e: unknown) => unknown,
        ) => Promise.resolve(undefined).then(resolve, reject),
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
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1 }]),
        then: (resolve: (v: undefined) => unknown) =>
          Promise.resolve(undefined).then(resolve),
      }),
    })),
    update: jest.fn().mockImplementation((table: unknown) => ({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(
            table === invitationEmailOtps ? [{ attempts: 1 }] : [],
          ),
          then: (resolve: (v: undefined) => unknown) =>
            Promise.resolve(undefined).then(resolve),
        }),
      }),
    })),
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (handle: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const cache = {
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
  };

  const emailService = {
    sendEmailOtpEmail: jest.fn().mockResolvedValue(undefined),
  };

  return { db, cache, tx, invitationFindFirst, otpFindFirst, emailService };
}

async function buildSvc(
  harness: ReturnType<typeof buildHarness>,
): Promise<InvitationAcceptanceService> {
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
      { provide: EmailService, useValue: harness.emailService },
    ],
  }).compile();
  return moduleRef.get(InvitationAcceptanceService);
}

describe("InvitationAcceptanceService — email OTP gate for new accounts (BUG-020)", () => {
  describe("requestInvitationEmailOtp", () => {
    it("sends a code and returns ok when the invitation token is valid", async () => {
      const harness = buildHarness();
      const svc = await buildSvc(harness);

      const result = await svc.requestInvitationEmailOtp(RAW_TOKEN);

      expect(result).toEqual({ ok: true });
      expect(harness.emailService.sendEmailOtpEmail).toHaveBeenCalledWith(
        INVITED_EMAIL,
        expect.stringMatching(/^\d{6}$/),
      );
    });

    it("rejects an expired or unknown invitation token without revealing that it exists", async () => {
      const harness = buildHarness();
      harness.invitationFindFirst.mockResolvedValue(null);
      const svc = await buildSvc(harness);

      await expect(svc.requestInvitationEmailOtp(RAW_TOKEN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(harness.emailService.sendEmailOtpEmail).not.toHaveBeenCalled();
    });
  });

  describe("accept — new user OTP gate", () => {
    it("blocks account creation when no email OTP is supplied", async () => {
      const harness = buildHarness();
      const svc = await buildSvc(harness);

      await expect(
        svc.accept({ token: RAW_TOKEN, firstName: "Jane" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("accepts the invitation and creates the account when the correct OTP is supplied", async () => {
      const harness = buildHarness();
      const svc = await buildSvc(harness);

      const result = await svc.accept({
        token: RAW_TOKEN,
        firstName: "Jane",
        emailOtp: VALID_OTP,
      });

      expect(result.ok).toBe(true);
      expect(typeof result.autoLoginToken).toBe("string");
    });

    it("rejects a wrong OTP with an unauthorized error, never with a 400", async () => {
      const harness = buildHarness();
      const svc = await buildSvc(harness);

      await expect(
        svc.accept({ token: RAW_TOKEN, emailOtp: WRONG_OTP }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("accepts the invitation with the correct OTP after a wrong attempt is refused", async () => {
      const harness = buildHarness();
      const svc = await buildSvc(harness);

      await expect(
        svc.accept({ token: RAW_TOKEN, emailOtp: WRONG_OTP }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      harness.db.update.mockImplementation((table: unknown) => ({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(
              table === invitationEmailOtps ? [{ attempts: 2 }] : [],
            ),
            then: (resolve: (v: undefined) => unknown) =>
              Promise.resolve(undefined).then(resolve),
          }),
        }),
      }));

      const result = await svc.accept({
        token: RAW_TOKEN,
        firstName: "Jane",
        emailOtp: VALID_OTP,
      });

      expect(result.ok).toBe(true);
    });
  });
});
