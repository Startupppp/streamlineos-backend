import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";

describe("CRM Automations & Products (e2e)", () => {
  let app: INestApplication;
  let managerToken: string;
  let memberToken: string;
  let otherOrgToken: string;

  beforeAll(async () => {
    app = await createE2eApp();

    managerToken = await signToken({
      sub: "user_crm_mgr",
      orgId: "org_crm_test",
      enabledModules: ["crm"],
      permissions: ["crm:automations:manage", "crm:products:manage"],
    });
    memberToken = await signToken({
      sub: "user_crm_mbr",
      orgId: "org_crm_test",
      enabledModules: ["crm"],
      permissions: [],
    });
    otherOrgToken = await signToken({
      sub: "user_other",
      orgId: "org_other",
      enabledModules: ["crm"],
      permissions: ["crm:automations:manage", "crm:products:manage"],
    });
  });

  afterAll(async () => app.close());

  describe("Authentication — 401 without token", () => {
    const routes: ReadonlyArray<["get" | "post" | "patch" | "delete", string]> = [
      ["get", "/crm/automations"],
      ["post", "/crm/automations"],
      ["patch", "/crm/automations/1"],
      ["delete", "/crm/automations/1"],
      ["get", "/crm/products"],
      ["post", "/crm/products"],
      ["patch", "/crm/products/1"],
      ["delete", "/crm/products/1"],
    ];

    it.each(routes)("401 on %s %s", async (method, path) => {
      const agent = request(app.getHttpServer());
      const res = await (method === "get"
        ? agent.get(path)
        : method === "post"
          ? agent.post(path)
          : method === "patch"
            ? agent.patch(path)
            : agent.delete(path));
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
    });
  });

  describe("RBAC — 403 without crm:automations:manage permission", () => {
    it("GET /crm/automations → 403 for member without permission", async () => {
      const res = await request(app.getHttpServer())
        .get("/crm/automations")
        .set("Authorization", `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    });

    it("POST /crm/automations → 403 for member without permission", async () => {
      const res = await request(app.getHttpServer())
        .post("/crm/automations")
        .set("Authorization", `Bearer ${memberToken}`)
        .send({
          name: "Test",
          trigger: "lead.created",
          conditions: [{ field: "status", operator: "equals", value: "NEW" }],
          actions: ["send_email"],
          isActive: true,
        });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    });

    it("GET /crm/products → 403 for member without permission", async () => {
      const res = await request(app.getHttpServer())
        .get("/crm/products")
        .set("Authorization", `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    });

    it("POST /crm/products → 403 for member without permission", async () => {
      const res = await request(app.getHttpServer())
        .post("/crm/products")
        .set("Authorization", `Bearer ${memberToken}`)
        .send({ name: "Widget", unitPrice: 999 });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    });
  });

  describe("Automations CRUD happy path", () => {
    let createdRuleId: number;

    it("POST /crm/automations → 201 with rule in response", async () => {
      const res = await request(app.getHttpServer())
        .post("/crm/automations")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          name: "Notify on new lead",
          trigger: "lead.created",
          conditions: [{ field: "status", operator: "equals", value: "NEW" }],
          actions: ["send_email", "create_task"],
          isActive: true,
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("rule");
      expect(res.body.rule).toMatchObject({
        name: "Notify on new lead",
        trigger: "lead.created",
        isActive: true,
        executionCount: 0,
      });
      createdRuleId = res.body.rule.id as number;
    });

    it("GET /crm/automations → 200 with rules array", async () => {
      const res = await request(app.getHttpServer())
        .get("/crm/automations")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("rules");
      expect(Array.isArray(res.body.rules)).toBe(true);
      const found = (res.body.rules as { id: number }[]).find((r) => r.id === createdRuleId);
      expect(found).toBeDefined();
    });

    it("PATCH /crm/automations/:ruleId → 200 with updated rule", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/crm/automations/${createdRuleId}`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ isActive: false });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("rule");
      expect(res.body.rule.isActive).toBe(false);
    });

    it("DELETE /crm/automations/:ruleId → 200 with success", async () => {
      const res = await request(app.getHttpServer())
        .delete(`/crm/automations/${createdRuleId}`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it("DELETE /crm/automations/:ruleId → 404 for already-deleted rule", async () => {
      const res = await request(app.getHttpServer())
        .delete(`/crm/automations/${createdRuleId}`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("Products CRUD happy path", () => {
    let createdProductId: number;

    it("POST /crm/products → 201 with product in response", async () => {
      const res = await request(app.getHttpServer())
        .post("/crm/products")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          name: "Enterprise License",
          description: "Annual enterprise plan",
          sku: "ENT-001",
          category: "Software",
          unitPrice: 9999,
          currency: "INR",
          taxRate: 18,
        });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "Enterprise License",
        sku: "ENT-001",
        unitPrice: 9999,
        taxRate: 18,
        currency: "INR",
        isActive: true,
      });
      createdProductId = (res.body as { id: number }).id;
    });

    it("GET /crm/products → 200 with products and total", async () => {
      const res = await request(app.getHttpServer())
        .get("/crm/products")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("products");
      expect(res.body).toHaveProperty("total");
      expect(typeof res.body.total).toBe("number");
    });

    it("GET /crm/products?search=Enterprise → filters by name", async () => {
      const res = await request(app.getHttpServer())
        .get("/crm/products?search=Enterprise")
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      const products = res.body.products as { name: string }[];
      expect(products.every((p) => p.name.toLowerCase().includes("enterprise"))).toBe(true);
    });

    it("PATCH /crm/products/:productId → 200 with updated product", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/crm/products/${createdProductId}`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ isActive: false, unitPrice: 8999 });
      expect(res.status).toBe(200);
      expect(res.body.isActive).toBe(false);
      expect(res.body.unitPrice).toBe(8999);
    });

    it("DELETE /crm/products/:productId → 200 with success", async () => {
      const res = await request(app.getHttpServer())
        .delete(`/crm/products/${createdProductId}`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it("DELETE /crm/products/:productId → 404 for already-deleted product", async () => {
      const res = await request(app.getHttpServer())
        .delete(`/crm/products/${createdProductId}`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe("Cross-tenant isolation", () => {
    let orgAProductId: number;
    let orgARuleId: number;

    it("Product created by org A is not visible to org B", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/crm/products")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ name: "Org A Exclusive", unitPrice: 500, currency: "INR" });
      expect(createRes.status).toBe(201);
      orgAProductId = (createRes.body as { id: number }).id;

      const listRes = await request(app.getHttpServer())
        .get("/crm/products")
        .set("Authorization", `Bearer ${otherOrgToken}`);
      expect(listRes.status).toBe(200);
      const ids = (listRes.body.products as { id: number }[]).map((p) => p.id);
      expect(ids).not.toContain(orgAProductId);
    });

    it("PATCH /crm/products by org B on org A resource → 404", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/crm/products/${orgAProductId}`)
        .set("Authorization", `Bearer ${otherOrgToken}`)
        .send({ name: "Hijacked" });
      expect(res.status).toBe(404);
    });

    it("DELETE /crm/products by org B on org A resource → 404", async () => {
      const res = await request(app.getHttpServer())
        .delete(`/crm/products/${orgAProductId}`)
        .set("Authorization", `Bearer ${otherOrgToken}`);
      expect(res.status).toBe(404);
    });

    it("Automation rule created by org A is not visible to org B", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/crm/automations")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({
          name: "Org A Private Rule",
          trigger: "lead.assigned",
          conditions: [{ field: "priority", operator: "equals", value: "HIGH" }],
          actions: ["send_notification"],
          isActive: true,
        });
      expect(createRes.status).toBe(201);
      orgARuleId = (createRes.body.rule as { id: number }).id;

      const listRes = await request(app.getHttpServer())
        .get("/crm/automations")
        .set("Authorization", `Bearer ${otherOrgToken}`);
      expect(listRes.status).toBe(200);
      const ids = (listRes.body.rules as { id: number }[]).map((r) => r.id);
      expect(ids).not.toContain(orgARuleId);
    });

    it("PATCH /crm/automations by org B on org A resource → 404", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/crm/automations/${orgARuleId}`)
        .set("Authorization", `Bearer ${otherOrgToken}`)
        .send({ isActive: false });
      expect(res.status).toBe(404);
    });

    it("DELETE /crm/automations by org B on org A resource → 404", async () => {
      const res = await request(app.getHttpServer())
        .delete(`/crm/automations/${orgARuleId}`)
        .set("Authorization", `Bearer ${otherOrgToken}`);
      expect(res.status).toBe(404);
    });
  });
});
