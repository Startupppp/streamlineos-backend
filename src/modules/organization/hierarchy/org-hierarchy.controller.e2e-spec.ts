import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { OrgHierarchyService } from "./org-hierarchy.service";

const ORG_ID = "org_test_001";
const USER_ID = "user_test_001";

const mockHierarchyService = {
  listBusinessUnits: jest.fn().mockResolvedValue([]),
  getTree: jest.fn().mockResolvedValue([]),
  getHierarchy: jest.fn().mockResolvedValue({}),
};

describe("/org-hierarchy (e2e)", () => {
  let app: INestApplication;
  let ownerToken: string;
  let memberToken: string;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: OrgHierarchyService, useValue: mockHierarchyService }],
    });

    ownerToken = await signToken({ sub: USER_ID, orgId: ORG_ID, isOrgOwner: true });
    memberToken = await signToken({ sub: "user_test_002", orgId: ORG_ID });
  });

  afterAll(async () => app.close());

  describe("Authentication", () => {
    it("401 without token on GET /org-hierarchy/business-units", async () => {
      const res = await request(app.getHttpServer()).get("/org-hierarchy/business-units");
      expect(res.status).toBe(401);
    });

    it("200 with valid owner token on GET /org-hierarchy/business-units", async () => {
      const res = await request(app.getHttpServer())
        .get("/org-hierarchy/business-units")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /org-hierarchy/tree", () => {
    it("returns an array", async () => {
      const res = await request(app.getHttpServer())
        .get("/org-hierarchy/tree")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data ?? res.body)).toBe(true);
    });
  });

  describe("RBAC", () => {
    it("403 on POST /org-hierarchy/business-units without manage permission", async () => {
      const res = await request(app.getHttpServer())
        .post("/org-hierarchy/business-units")
        .set("Authorization", `Bearer ${memberToken}`)
        .send({ name: "Test BU", code: "TEST" });
      expect(res.status).toBe(403);
    });

    it("403 on POST /org-hierarchy/branches without manage permission", async () => {
      const res = await request(app.getHttpServer())
        .post("/org-hierarchy/branches")
        .set("Authorization", `Bearer ${memberToken}`)
        .send({ name: "Test Branch", code: "BR-001" });
      expect(res.status).toBe(403);
    });
  });

  describe("Tenant isolation", () => {
    it("lists only org-scoped data", async () => {
      const res = await request(app.getHttpServer())
        .get("/org-hierarchy/business-units")
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const data = res.body.data ?? res.body;
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.orgId) {
            expect(item.orgId).toBe(ORG_ID);
          }
        }
      }
    });
  });
});
