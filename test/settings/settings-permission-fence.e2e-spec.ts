import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createE2eApp, accessStub } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AccessService } from "src/modules/access/access.service";
import { SettingsService } from "src/modules/settings/settings.service";
import { SettingsAutomationsService } from "src/modules/settings/settings-automations.service";
import { AiUsageService } from "src/modules/ai/usage/ai-usage.service";
import { GitConnectionsService } from "src/modules/integrations/git/git-connections.service";
import { CrmCustomFieldsService } from "src/modules/crm/custom-fields/crm-custom-fields.service";

const NOW = new Date("2026-01-01T00:00:00.000Z");

const stubSettings = {
  getSectionProvenance: jest.fn().mockResolvedValue({}),
  listApiKeys: jest.fn().mockResolvedValue([]),
  createApiKey: jest.fn().mockResolvedValue({ id: "key_1", key: "sk_test_abc", keyPrefix: "sk_te", name: "Test Key", scopes: [] }),
  revokeApiKey: jest.fn().mockResolvedValue({ success: true as const }),
  getFeatureFlags: jest.fn().mockResolvedValue({ aiChat: false, aiLeadScoring: false, aiEmailDraft: false, aiSmartNotifications: false, aiWeeklyRecap: false, supportAi: false }),
  updateFeatureFlag: jest.fn().mockResolvedValue({ success: true as const, flag: "aiChat", enabled: true }),
  updateUserRole: jest.fn().mockResolvedValue({ success: true as const, userId: "user_2", role: "MEMBER" }),
};

const AUTOMATION_ROW = {
  id: 1,
  orgId: "org_1",
  name: "Test Rule",
  description: null,
  triggerEvent: "lead.created",
  conditions: null,
  actions: null,
  isEnabled: true,
  runCount: 0,
  lastRunAt: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const stubAutomations = {
  listAutomations: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }),
  createAutomation: jest.fn().mockResolvedValue(AUTOMATION_ROW),
  getAutomation: jest.fn().mockResolvedValue(AUTOMATION_ROW),
  updateAutomation: jest.fn().mockResolvedValue(AUTOMATION_ROW),
  deleteAutomation: jest.fn().mockResolvedValue({ success: true as const }),
  listAutomationRuns: jest.fn().mockResolvedValue([]),
};

const stubAiUsage = {
  getOrgUsage: jest.fn().mockResolvedValue({
    totals: { totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: "0.00", requestCount: 0 },
    byFeature: [],
    daily: [],
    performance: { avgLatencyMs: null, p95LatencyMs: null, errorRate: 0 },
    acceptance: { feedbackByFeature: [], suggestions: { accepted: 0, rejected: 0, pending: 0 } },
  }),
};

const GIT_CREATE_ROW = {
  id: 1,
  provider: "github",
  projectId: null,
  repoUrl: "https://github.com/test/repo",
  repoName: "repo",
  isActive: true,
  webhookUrl: "https://api.example.com/webhooks/git/1",
  webhookSecret: "whs_test",
  createdAt: NOW,
  updatedAt: NOW,
};

const GIT_UPDATE_ROW = { id: 1, provider: "github", projectId: null, repoUrl: "https://github.com/test/repo", repoName: "repo", isActive: true, createdAt: NOW, updatedAt: NOW };

const stubGit = {
  listConnections: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 100, hasMore: false, nextCursor: null } }),
  createConnection: jest.fn().mockResolvedValue(GIT_CREATE_ROW),
  updateConnection: jest.fn().mockResolvedValue(GIT_UPDATE_ROW),
  deleteConnection: jest.fn().mockResolvedValue({ success: true as const }),
};

const CUSTOM_FIELD_ROW = {
  id: 1,
  entityType: "contact",
  name: "custom_field_1",
  label: "Custom Field",
  fieldType: "text",
  options: null,
  isRequired: false,
  isActive: true,
  sortOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const stubCustomFields = {
  listCustomFields: jest.fn().mockResolvedValue({ fields: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }),
  createCustomField: jest.fn().mockResolvedValue({ field: CUSTOM_FIELD_ROW }),
  updateCustomField: jest.fn().mockResolvedValue({ field: CUSTOM_FIELD_ROW }),
  deleteCustomField: jest.fn().mockResolvedValue({ success: true as const }),
};

const SERVICE_OVERRIDES = [
  { provide: SettingsService, useValue: stubSettings },
  { provide: SettingsAutomationsService, useValue: stubAutomations },
  { provide: AiUsageService, useValue: stubAiUsage },
  { provide: GitConnectionsService, useValue: stubGit },
  { provide: CrmCustomFieldsService, useValue: stubCustomFields },
];

type FenceCase = readonly [method: string, path: string, key: string, body: Record<string, unknown>, happyStatus: number];

const SETTINGS_CASES: ReadonlyArray<FenceCase> = [
  ["GET",    "/settings/provenance?sections=org",        "settings:view",                {}, 200],
  ["GET",    "/settings/api-keys",                     "settings:manage",              {}, 200],
  ["POST",   "/settings/api-keys",                     "settings:manage",              { name: "Test Key" }, 201],
  ["DELETE", "/settings/api-keys/key_1",               "settings:manage",              {}, 200],
  ["GET",    "/settings/automations",                  "settings:automations:view",    {}, 200],
  ["POST",   "/settings/automations",                  "settings:automations:manage",  { name: "Test Rule", triggerEvent: "lead.created", actions: [{ type: "support_internal_note", config: { body: "note" } }] }, 201],
  ["GET",    "/settings/automations/1",                "settings:automations:view",    {}, 200],
  ["PATCH",  "/settings/automations/1",                "settings:automations:manage",  { isEnabled: false }, 200],
  ["DELETE", "/settings/automations/1",                "settings:automations:manage",  {}, 200],
  ["GET",    "/settings/automations/1/runs",           "settings:automations:view",    {}, 200],
  ["GET",    "/settings/feature-flags",                "settings:view",                {}, 200],
  ["PATCH",  "/settings/feature-flags",                "settings:manage",              { flag: "aiChat", enabled: true }, 200],
  ["GET",    "/settings/ai-usage",                     "ai:usage:view",                {}, 200],
  ["GET",    "/settings/integrations/git",             "integrations:git:view",        {}, 200],
  ["POST",   "/settings/integrations/git",             "integrations:git:manage",      { provider: "github", repoUrl: "https://github.com/test/repo" }, 201],
  ["PATCH",  "/settings/integrations/git/1",           "integrations:git:manage",      { isActive: true }, 200],
  ["DELETE", "/settings/integrations/git/1",           "integrations:git:manage",      {}, 200],
  ["POST",   "/settings/users/user_2/role",            "settings:rbac:manage",         { role: "MEMBER" }, 201],
  ["GET",    "/settings/custom-fields",                "settings:custom-fields:view",  {}, 200],
  ["POST",   "/settings/custom-fields",                "settings:custom-fields:manage",{ entityType: "contact", name: "custom_field_1", label: "Custom Field" }, 201],
  ["PATCH",  "/settings/custom-fields/1",              "settings:custom-fields:manage",{ label: "Updated Field" }, 200],
  ["DELETE", "/settings/custom-fields/1",              "settings:custom-fields:manage",{}, 200],
] as const;

describe("Settings permission fence — HTTP boundary", () => {
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

  describe("401 — unauthenticated request rejected", () => {
    it.each(SETTINGS_CASES)("%s %s → 401 with no token", async (method, path, _key, body) => {
      const res = await call(method, path).send(body);
      expect(res.status).toBe(401);
    });
  });

  describe("403 — authenticated but missing permission", () => {
    it.each(SETTINGS_CASES)("%s %s → 403 with empty-permission token", async (method, path, _key, body) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(403);
    });
  });

  describe("happy path — permission holder allowed", () => {
    it.each(SETTINGS_CASES)("%s %s → %s with correct permission", async (method, path, key, body, happyStatus) => {
      const token = await signToken({ permissions: [key], enabledModules: ALL_MODULES });
      const res = await call(method, path).set("Authorization", `Bearer ${token}`).send(body);
      expect(res.status).toBe(happyStatus);
    });
  });
});

describe("Settings route coverage index — 401 without auth on all routes", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({ overrides: SERVICE_OVERRIDES });
  });

  afterAll(async () => {
    await app.close();
  });

  it("all settings routes reject unauthenticated requests", async () => {
    const s = request(app.getHttpServer());
    const check = (r: request.Test) => r.send({});
    
    await expect((await check(s.get("/settings/provenance"))).status).toBe(401);
    await expect((await check(s.get("/settings/api-keys"))).status).toBe(401);
    await expect((await check(s.post("/settings/api-keys"))).status).toBe(401);
    await expect((await check(s.delete("/settings/api-keys/key_1"))).status).toBe(401);
    await expect((await check(s.get("/settings/automations"))).status).toBe(401);
    await expect((await check(s.post("/settings/automations"))).status).toBe(401);
    await expect((await check(s.get("/settings/automations/1"))).status).toBe(401);
    await expect((await check(s.patch("/settings/automations/1"))).status).toBe(401);
    await expect((await check(s.delete("/settings/automations/1"))).status).toBe(401);
    await expect((await check(s.get("/settings/automations/1/runs"))).status).toBe(401);
    await expect((await check(s.get("/settings/feature-flags"))).status).toBe(401);
    await expect((await check(s.patch("/settings/feature-flags"))).status).toBe(401);
    await expect((await check(s.get("/settings/ai-usage"))).status).toBe(401);
    await expect((await check(s.get("/settings/integrations/git"))).status).toBe(401);
    await expect((await check(s.post("/settings/integrations/git"))).status).toBe(401);
    await expect((await check(s.patch("/settings/integrations/git/1"))).status).toBe(401);
    await expect((await check(s.delete("/settings/integrations/git/1"))).status).toBe(401);
    await expect((await check(s.post("/settings/users/user_2/role"))).status).toBe(401);
    await expect((await check(s.get("/settings/custom-fields"))).status).toBe(401);
    await expect((await check(s.post("/settings/custom-fields"))).status).toBe(401);
    await expect((await check(s.patch("/settings/custom-fields/1"))).status).toBe(401);
    await expect((await check(s.delete("/settings/custom-fields/1"))).status).toBe(401);
  });
});

describe("Settings fence bite proof — guard bites (not a coincidence)", () => {
  let fenceApp: INestApplication;
  let neutralApp: INestApplication;

  beforeAll(async () => {
    [fenceApp, neutralApp] = await Promise.all([
      createE2eApp({ overrides: SERVICE_OVERRIDES }),
      createE2eApp({
        overrides: [
          ...SERVICE_OVERRIDES,
          { provide: AccessService, useValue: { ...accessStub, holds: async (): Promise<boolean> => true, scopeFor: async (): Promise<string> => "all" } },
        ],
      }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([fenceApp.close(), neutralApp.close()]);
  });

  it("with AccessService.holds neutered, PATCH /settings/feature-flags no longer returns 403 for empty-permission token", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(neutralApp.getHttpServer())
      .patch("/settings/feature-flags")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID())
      .send({ flag: "aiChat", enabled: true });
    expect(res.status).toBe(200);
  });

  it("with real guard restored, identical request returns 403 — neutered test above was measuring the guard", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(fenceApp.getHttpServer())
      .patch("/settings/feature-flags")
      .set("Authorization", `Bearer ${token}`)
      .send({ flag: "aiChat", enabled: true });
    expect(res.status).toBe(403);
  });
});
