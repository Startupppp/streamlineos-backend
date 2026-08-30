import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken, ALL_MODULES } from "test/helpers/sign-token";

const WORKFLOW_MODULE = "workflows";
const WORKFLOW_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG_ID = "other-org-id";

describe("WorkflowsController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => app.close());

  describe("Unauthenticated", () => {
    it("401 GET /workflows without token", async () => {
      const res = await request(app.getHttpServer()).get("/workflows");
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("401 POST /workflows without token", async () => {
      const res = await request(app.getHttpServer()).post("/workflows").send({ name: "test" });
      expect(res.status).toBe(401);
    });

    it("401 GET /workflows/secrets without token", async () => {
      const res = await request(app.getHttpServer()).get("/workflows/secrets");
      expect(res.status).toBe(401);
    });
  });

  describe("Module disabled", () => {
    it("403 GET /workflows when WORKFLOWS module is disabled", async () => {
      const token = await signToken({
        permissions: ["workflows:workflows:view"],
        enabledModules: ALL_MODULES.filter((m) => m !== WORKFLOW_MODULE),
      });
      const res = await request(app.getHttpServer())
        .get("/workflows")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("403 GET /workflows/analytics when WORKFLOWS module is disabled", async () => {
      const token = await signToken({
        permissions: ["workflows:analytics:view"],
        enabledModules: ALL_MODULES.filter((m) => m !== WORKFLOW_MODULE),
      });
      const res = await request(app.getHttpServer())
        .get("/workflows/analytics")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  });

  describe("Permission denied", () => {
    it("403 GET /workflows without workflows:workflows:view", async () => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await request(app.getHttpServer())
        .get("/workflows")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("403 POST /workflows without workflows:workflows:create", async () => {
      const token = await signToken({
        permissions: ["workflows:workflows:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .post("/workflows")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "test" });
      expect(res.status).toBe(403);
    });

    it("403 GET /workflows/secrets without workflows:secrets:manage", async () => {
      const token = await signToken({
        permissions: ["workflows:workflows:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .get("/workflows/secrets")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("403 GET /workflows/variables without workflows:variables:manage", async () => {
      const token = await signToken({
        permissions: ["workflows:workflows:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .get("/workflows/variables")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("403 GET /workflows/approvals/pending without workflows:approvals:view", async () => {
      const token = await signToken({
        permissions: ["workflows:workflows:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .get("/workflows/approvals/pending")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("403 GET /workflows/executions without workflows:executions:view", async () => {
      const token = await signToken({
        permissions: ["workflows:workflows:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .get("/workflows/executions")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("403 GET /workflows/schedules without workflows:schedules:manage", async () => {
      const token = await signToken({
        permissions: ["workflows:workflows:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .get("/workflows/schedules")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("403 POST /workflows/:id/trigger without workflows:executions:manage", async () => {
      const token = await signToken({
        permissions: ["workflows:workflows:view", "workflows:executions:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .post(`/workflows/${WORKFLOW_ID}/trigger`)
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(403);
    });

    it("403 POST /workflows/:id/publish without workflows:workflows:publish", async () => {
      const token = await signToken({
        permissions: ["workflows:workflows:view", "workflows:workflows:update"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .post(`/workflows/${WORKFLOW_ID}/publish`)
        .set("Authorization", `Bearer ${token}`)
        .send({ definitionJson: {} });
      expect(res.status).toBe(403);
    });
  });

  describe("Cross-tenant isolation — 404 not 403", () => {
    it("404 (not 403) GET /workflows/:id for a workflow in another org", async () => {
      const token = await signToken({
        sub: "user_a",
        orgId: "org_a",
        permissions: ["workflows:workflows:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .get(`/workflows/${WORKFLOW_ID}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);
    });

    it("404 (not 403) PATCH /workflows/:id for a workflow in another org", async () => {
      const token = await signToken({
        sub: "user_a",
        orgId: "org_a",
        permissions: ["workflows:workflows:update"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .patch(`/workflows/${WORKFLOW_ID}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "probe" });
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);
    });
  });

  describe("Secret redaction", () => {
    it("GET /workflows/secrets never includes encryptedValue in the response body", async () => {
      const token = await signToken({
        permissions: ["workflows:secrets:manage"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .get("/workflows/secrets")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("encryptedValue");
      expect(JSON.stringify(res.body)).not.toContain("encrypted_value");
    });

    it("POST /workflows/:id/secrets never returns encryptedValue in the response body", async () => {
      const token = await signToken({
        permissions: ["workflows:secrets:manage", "workflows:workflows:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .post(`/workflows/${WORKFLOW_ID}/secrets`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "TEST_SECRET", value: "super-secret-value" });
      expect(res.status).not.toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("super-secret-value");
      expect(JSON.stringify(res.body)).not.toContain("encryptedValue");
    });
  });

  describe("Org owner bypass", () => {
    it("200 GET /workflows for org owner regardless of permission grants", async () => {
      const token = await signToken({
        permissions: [],
        enabledModules: ALL_MODULES,
        isOrgOwner: true,
      });
      const res = await request(app.getHttpServer())
        .get("/workflows")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });
});
