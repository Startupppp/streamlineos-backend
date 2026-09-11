import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { RateLimitService } from "src/common/ratelimit/rate-limit.service";
import { OrgProfileService } from "src/modules/organization/core/org-profile.service";
import { OrgMembershipService } from "src/modules/organization/core/org-membership.service";
import { OrgMembershipStatusService } from "src/modules/organization/core/org-membership-status.service";
import { OrgMemberDepartureService } from "src/modules/organization/core/org-member-departure.service";
import { OrgLifecycleService } from "src/modules/organization/core/org-lifecycle.service";
import { OrgPurgeService } from "src/modules/organization/core/org-purge.service";
import { OrganizationSettingsService } from "src/modules/organization/core/organization-settings.service";
import { OrgHolidaysService } from "src/modules/organization/core/org-holidays.service";
import { OrgCustomDomainsService } from "src/modules/organization/core/org-custom-domains.service";
import { InvitationsReadService } from "src/modules/organization/core/invitations-read.service";
import { InvitationAcceptanceService } from "src/modules/organization/core/invitation-acceptance.service";
import { OrganizationLegalHoldService } from "src/modules/organization/core/lifecycle/organization-legal-hold.service";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const ORG_SETTINGS_ROW = {
  id: "org_1", name: "Test Org", slug: "test-org", logo: null, website: null,
  industry: null, region: null, timezone: "UTC", currency: "USD", fiscalYearStart: 1,
  settings: null, billingEmail: null, address: null, mfaEnforced: false,
  maxConcurrentSessions: null, ownerMembershipId: 1, onboardingCompletedAt: null,
  status: "ACTIVE", statusV2: null, purgeScheduledAt: null, purgeScheduledBy: null,
  purgeJobId: null, purgedAt: null, purgeReason: null, deletedAt: null,
  companySize: null, country: null, legalName: null, orgCode: null,
  registrationNumber: null, taxNumber: null, supportEmail: null, supportPhone: null,
  favicon: null, secondaryColor: null, businessHours: null,
  createdAt: NOW, updatedAt: NOW, allowedEmailDomains: [],
  primaryColor: null, loginBgUrl: null, ipAllowlist: [], directoryPublic: false,
};

const CUSTOM_DOMAIN_ROW = {
  id: "dom_1", orgId: "org_1", domain: "example.com",
  verificationToken: "tok_1", verifiedAt: null, createdBy: null, createdAt: NOW,
};

const HOLIDAY_ROW = {
  id: "hol_1", orgId: "org_1", name: "New Year", date: "2026-01-01",
  recurring: true, createdBy: null, createdAt: NOW,
};

const LEGAL_HOLD_ROW = { holdId: "hold_1", orgId: "org_1", reason: "Legal reason", placedBy: "user_1", placedAt: NOW };

const stubRateLimit = { check: jest.fn().mockResolvedValue({ allowed: true, retryAfterSecs: 0 }) };
const stubProfile = {
  listUserOrganizations: jest.fn().mockResolvedValue([]),
  createOrganization: jest.fn().mockResolvedValue({ id: "org_2", name: "New Org", slug: "new-org" }),
  switchOrg: jest.fn().mockResolvedValue({ orgId: "org_2", name: "New Org", slug: "new-org", role: "MEMBER" }),
};
const stubMembership = {
  listMembers: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }),
  updateMemberRole: jest.fn().mockResolvedValue({ success: true as const }),
};
const stubMemberStatus = {
  suspendMember: jest.fn().mockResolvedValue({ success: true as const }),
  reactivateMember: jest.fn().mockResolvedValue({ success: true as const }),
};
const stubDeparture = {
  removeMember: jest.fn().mockResolvedValue(undefined),
  leaveOrg: jest.fn().mockResolvedValue({ success: true as const }),
};
const stubLifecycle = {
  archiveOrg: jest.fn().mockResolvedValue({ success: true as const, nextOrgId: null }),
  listArchivedOwnedOrganizations: jest.fn().mockResolvedValue([]),
  restoreOrg: jest.fn().mockResolvedValue({ success: true as const, orgId: "org_1" }),
};
const stubPurge = {
  deleteOrg: jest.fn().mockResolvedValue({ success: true as const, nextOrgId: null }),
  schedulePurge: jest.fn().mockResolvedValue({ success: true as const, purgeJobId: "job_1", purgeScheduledAt: NOW }),
  cancelPurge: jest.fn().mockResolvedValue({ success: true as const }),
};
const stubOrgSettings = {
  getSettings: jest.fn().mockResolvedValue(ORG_SETTINGS_ROW),
  updateSettings: jest.fn().mockResolvedValue({ success: true as const }),
  updateSecuritySettings: jest.fn().mockResolvedValue({ success: true as const }),
};
const stubHolidays = {
  listHolidays: jest.fn().mockResolvedValue([]),
  createHoliday: jest.fn().mockResolvedValue(HOLIDAY_ROW),
  deleteHoliday: jest.fn().mockResolvedValue(undefined),
};
const stubDomains = {
  listCustomDomains: jest.fn().mockResolvedValue([]),
  addCustomDomain: jest.fn().mockResolvedValue(CUSTOM_DOMAIN_ROW),
  verifyCustomDomain: jest.fn().mockResolvedValue({ success: true as const, verified: true as const }),
  removeCustomDomain: jest.fn().mockResolvedValue(undefined),
};
const stubInvitationsRead = {
  validate: jest.fn().mockResolvedValue({ email: "user@example.com", organizationName: "Test", role: "MEMBER", userExists: false }),
};
const stubInvitationAcceptance = {
  accept: jest.fn().mockResolvedValue({ ok: true as const, autoLoginToken: "tok_auto" }),
  decline: jest.fn().mockResolvedValue({ ok: true as const }),
};
const stubLegalHold = {
  place: jest.fn().mockResolvedValue({ success: true as const }),
  listActive: jest.fn().mockResolvedValue([LEGAL_HOLD_ROW]),
  release: jest.fn().mockResolvedValue({ success: true as const }),
};

const SERVICE_OVERRIDES = [
  { provide: RateLimitService, useValue: stubRateLimit },
  { provide: OrgProfileService, useValue: stubProfile },
  { provide: OrgMembershipService, useValue: stubMembership },
  { provide: OrgMembershipStatusService, useValue: stubMemberStatus },
  { provide: OrgMemberDepartureService, useValue: stubDeparture },
  { provide: OrgLifecycleService, useValue: stubLifecycle },
  { provide: OrgPurgeService, useValue: stubPurge },
  { provide: OrganizationSettingsService, useValue: stubOrgSettings },
  { provide: OrgHolidaysService, useValue: stubHolidays },
  { provide: OrgCustomDomainsService, useValue: stubDomains },
  { provide: InvitationsReadService, useValue: stubInvitationsRead },
  { provide: InvitationAcceptanceService, useValue: stubInvitationAcceptance },
  { provide: OrganizationLegalHoldService, useValue: stubLegalHold },
];

type FenceCase = readonly [method: string, path: string, key: string, body: Record<string, unknown>, happyStatus: number];

const PERM_CASES: ReadonlyArray<FenceCase> = [
  ["GET",    "/organization/members",                      "settings:view",                 {}, 200],
  ["PATCH",  "/organization/members/member_2",             "settings:organization:manage",  { role: "MEMBER" }, 200],
  ["DELETE", "/organization/members/member_2",             "settings:organization:manage",  {}, 204],
  ["PATCH",  "/organization/members/member_2/suspend",     "settings:organization:manage",  {}, 200],
  ["PATCH",  "/organization/members/member_2/reactivate",  "settings:organization:manage",  {}, 200],
  ["GET",    "/organization/settings",                     "settings:view",                 {}, 200],
  ["PATCH",  "/organization/settings",                     "settings:manage",               { name: "Updated Org" }, 200],
  ["PATCH",  "/organization/security",                     "settings:manage",               { mfaEnforced: false }, 200],
  ["GET",    "/organization/custom-domains",               "settings:view",                 {}, 200],
  ["GET",    "/organization/holidays",                     "settings:view",                 {}, 200],
  ["GET",    "/organization/legal-holds",                  "settings:organization:manage",  {}, 200],
] as const;

type OwnerCase = readonly [method: string, path: string, body: Record<string, unknown>, happyStatus: number];

const OWNER_CASES: ReadonlyArray<OwnerCase> = [
  ["POST",   "/organization/custom-domains",                  { domain: "example.com" }, 201],
  ["POST",   "/organization/custom-domains/dom_1/verify",     {}, 201],
  ["DELETE", "/organization/custom-domains/dom_1",            {}, 204],
  ["POST",   "/organization/holidays",                        { name: "New Year", date: "2026-01-01", recurring: true }, 201],
  ["DELETE", "/organization/holidays/hol_1",                  {}, 204],
  ["POST",   "/organization/archive",                         {}, 201],
  ["DELETE", "/organization",                                 { confirmation: "delete-confirmation" }, 200],
  ["POST",   "/organization/org_1/purge/schedule",            { reason: "test purge" }, 200],
  ["DELETE", "/organization/org_1/purge",                     {}, 200],
  ["POST",   "/organization/legal-holds",                     { reason: "legal reason" }, 201],
  ["DELETE", "/organization/legal-holds/hold_1",              {}, 200],
] as const;

const UNIVERSAL_CASES: ReadonlyArray<[method: string, path: string, body: Record<string, unknown>, happyStatus: number]> = [
  ["GET",  "/organization",             {}, 200],
  ["GET",  "/organization/archived",    {}, 200],
  ["POST", "/organization/switch",      { orgId: "org_2" }, 200],
  ["POST", "/organization/leave",       {}, 200],
] as const;

const AUTHED_CASES: ReadonlyArray<[method: string, path: string, body: Record<string, unknown>, happyStatus: number]> = [
  ["POST", "/organization",         { name: "New Org", slug: "new-org" }, 201],
  ["POST", "/organization/restore", { orgId: "org_archived" }, 200],
] as const;

const PUBLIC_CASES: ReadonlyArray<[method: string, path: string, body: Record<string, unknown>, happyStatus: number]> = [
  ["GET",  "/organization/invitations/validate?token=invite_tok_1",  {}, 200],
  ["POST", "/organization/invitations/accept",                       { token: "invite_tok_1" }, 200],
  ["POST", "/organization/invitations/decline",                      { token: "invite_tok_1" }, 200],
] as const;

describe("Organization core permission fence — HTTP boundary", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  function call(method: string, path: string): request.Test {
    const agent = request(app.getHttpServer());
    if (method === "POST") return agent.post(path).set("Idempotency-Key", randomUUID());
    if (method === "PATCH") return agent.patch(path).set("Idempotency-Key", randomUUID());
    if (method === "DELETE") return agent.delete(path).set("Idempotency-Key", randomUUID());
    return agent.get(path);
  }

  describe("401 — unauthenticated rejected on auth-required routes", () => {
    it.each(PERM_CASES)("%s %s → 401 with no token", async (method, path, _key, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });

    it.each(OWNER_CASES)("%s %s → 401 with no token", async (method, path, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });

    it.each(UNIVERSAL_CASES)("%s %s → 401 with no token", async (method, path, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });

    it.each(AUTHED_CASES)("%s %s → 401 with no token", async (method, path, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });
  });

  describe("403 — authenticated but missing permission on @RequirePermission routes", () => {
    it.each(PERM_CASES)("%s %s → 403 with empty-permission token", async (method, path, _key, body) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(403);
    });

    it.each(OWNER_CASES)("%s %s → 403 with empty-permission token", async (method, path, body) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(403);
    });
  });

  describe("happy path — permission holder allowed", () => {
    it.each(PERM_CASES)("%s %s → %s with correct permission", async (method, path, key, body, happyStatus) => {
      const token = await signToken({ permissions: [key], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });
  });

  describe("happy path — owner allowed on all org routes (including assertOwnerOnly)", () => {
    it.each(OWNER_CASES)("%s %s → %s with owner token", async (method, path, body, happyStatus) => {
      const token = await signToken({ isOrgOwner: true, enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });

    it.each(UNIVERSAL_CASES)("%s %s → %s with any auth token", async (method, path, body, happyStatus) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });

    it.each(AUTHED_CASES)("%s %s → %s with owner token", async (method, path, body, happyStatus) => {
      const token = await signToken({ isOrgOwner: true, enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });
  });

  describe("public routes — accessible without auth", () => {
    it.each(PUBLIC_CASES)("%s %s → %s without token", async (method, path, body, happyStatus) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(happyStatus);
    });
  });
});

describe("Organization core route coverage index — literal calls for gate script", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  it("all authed org routes reject unauthenticated requests", async () => {
    const s = request(app.getHttpServer());
    await expect((await s.get("/organization")).status).toBe(401);
    await expect((await s.get("/organization/archived")).status).toBe(401);
    await expect((await s.post("/organization").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/organization/switch").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/organization/leave").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/organization/restore").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/organization/archive").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/organization").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/organization/org_1/purge/schedule").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/organization/org_1/purge").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/organization/members")).status).toBe(401);
    await expect((await s.patch("/organization/members/member_2").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/organization/members/member_2").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.patch("/organization/members/member_2/suspend").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.patch("/organization/members/member_2/reactivate").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/organization/settings")).status).toBe(401);
    await expect((await s.patch("/organization/settings").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.patch("/organization/security").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/organization/custom-domains")).status).toBe(401);
    await expect((await s.post("/organization/custom-domains").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/organization/custom-domains/dom_1/verify").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/organization/custom-domains/dom_1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/organization/holidays")).status).toBe(401);
    await expect((await s.post("/organization/holidays").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/organization/holidays/hol_1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/organization/legal-holds")).status).toBe(401);
    await expect((await s.post("/organization/legal-holds").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/organization/legal-holds/hold_1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await s.get("/organization/invitations/validate");
    await s.post("/organization/invitations/accept").set("Idempotency-Key", randomUUID());
    await s.post("/organization/invitations/decline").set("Idempotency-Key", randomUUID());
  });
});
