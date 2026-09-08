import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { WorkspaceOnboardingService } from "src/modules/organization/onboarding/workspace-onboarding.service";
import { AnnouncementsService } from "src/modules/organization/setup/announcements.service";
import { OrgMembersService } from "src/modules/organization/setup/org-members.service";
import { OrgSetupService } from "src/modules/organization/setup/org-setup.service";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const ANNOUNCEMENT_ROW = {
  id: 1,
  orgId: "org_1",
  title: "Important Announcement",
  content: "This is the announcement content text.",
  authorId: "user_1",
  targetType: "ALL",
  isPinned: false,
  publishAt: null,
  expiresAt: null,
  status: "DRAFT",
  readCount: 0,
  attachmentUrls: [],
  createdAt: NOW,
  updatedAt: NOW,
  targetIds: [],
};

const stubOnboarding = {
  generateWorkspace: jest.fn().mockResolvedValue({ businessUnits: [], branches: [], departments: [], teams: [] }),
  completeOnboarding: jest.fn().mockResolvedValue({ completedAt: NOW }),
};

const stubAnnouncements = {
  list: jest.fn().mockResolvedValue([]),
  listAll: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockResolvedValue(ANNOUNCEMENT_ROW),
  update: jest.fn().mockResolvedValue(ANNOUNCEMENT_ROW),
  remove: jest.fn().mockResolvedValue(undefined),
  markRead: jest.fn().mockResolvedValue(undefined),
};

const stubOrgMembers = {
  listMembers: jest.fn().mockResolvedValue([]),
};

const stubOrgSetup = {
  getSetupSession: jest.fn().mockResolvedValue({ id: 1, type: "SETUP", status: "PENDING", currentStep: null, completedSteps: [], skippedSteps: [], data: {} }),
  completeSetup: jest.fn().mockResolvedValue({ success: true as const, orgId: "org_1" }),
  skipSetup: jest.fn().mockResolvedValue({ success: true as const, orgId: "org_1" }),
};

const SERVICE_OVERRIDES = [
  { provide: WorkspaceOnboardingService, useValue: stubOnboarding },
  { provide: AnnouncementsService, useValue: stubAnnouncements },
  { provide: OrgMembersService, useValue: stubOrgMembers },
  { provide: OrgSetupService, useValue: stubOrgSetup },
];

type FenceCase = readonly [method: string, path: string, key: string, body: Record<string, unknown>, happyStatus: number];

const PERM_CASES: ReadonlyArray<FenceCase> = [
  ["POST", "/workspace-onboarding/generate",  "settings:organization:manage", { industry: "Technology" }, 200],
  ["POST", "/workspace-onboarding/complete",   "settings:organization:manage", {}, 200],
  ["GET",  "/org/announcements/all",           "hr:announcements:manage",      {}, 200],
  ["POST", "/org/announcements",               "hr:announcements:manage",      { title: "Important Announcement", content: "This is the announcement content text." }, 201],
  ["PATCH","/org/announcements/1",             "hr:announcements:manage",      { title: "Updated Announcement" }, 200],
  ["DELETE","/org/announcements/1",            "hr:announcements:manage",      {}, 200],
  ["GET",  "/org/members",                     "directory:people:view",         {}, 200],
] as const;

const UNIVERSAL_CASES: ReadonlyArray<[method: string, path: string, body: Record<string, unknown>, happyStatus: number]> = [
  ["GET",  "/org/announcements",      {}, 200],
  ["POST", "/org/announcements/1/read", {}, 201],
  ["GET",  "/org/setup/session",      {}, 200],
  ["POST", "/org/setup/complete",     { industry: "Technology", companySize: "50-200", enabledModules: ["hr"] }, 201],
  ["POST", "/org/setup/skip",         { reason: "Later" }, 201],
] as const;

describe("Org setup, workspace-onboarding and announcements permission fence — HTTP boundary", () => {
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

  describe("401 — unauthenticated request rejected on auth-required routes", () => {
    it.each(PERM_CASES)("%s %s → 401 with no token", async (method, path, _key, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });

    it.each(UNIVERSAL_CASES)("%s %s → 401 with no token", async (method, path, body) => {
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
  });

  describe("happy path — permission holder allowed", () => {
    it.each(PERM_CASES)("%s %s → %s with correct permission", async (method, path, key, body, happyStatus) => {
      const token = await signToken({ permissions: [key], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });

    it.each(UNIVERSAL_CASES)("%s %s → %s with any auth token", async (method, path, body, happyStatus) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });
  });
});

describe("Org setup route coverage index — literal calls for gate script", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  it("all org setup routes reject unauthenticated requests", async () => {
    const s = request(app.getHttpServer());
    await expect((await s.post("/workspace-onboarding/generate").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/workspace-onboarding/complete").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/org/announcements/all")).status).toBe(401);
    await expect((await s.get("/org/announcements")).status).toBe(401);
    await expect((await s.post("/org/announcements").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.patch("/org/announcements/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.delete("/org/announcements/1").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/org/announcements/1/read").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.get("/org/members")).status).toBe(401);
    await expect((await s.get("/org/setup/session")).status).toBe(401);
    await expect((await s.post("/org/setup/complete").set("Idempotency-Key", randomUUID())).status).toBe(401);
    await expect((await s.post("/org/setup/skip").set("Idempotency-Key", randomUUID())).status).toBe(401);
  });
});
