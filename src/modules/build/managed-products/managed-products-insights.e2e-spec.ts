import type { INestApplication } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { ManagedProductsService } from "./managed-products.service";
import { MembershipStateService } from "../../../common/auth/membership-state.service";

const managedProductsMock = {
  getProductInsights: jest.fn(),
};

describe("ManagedProducts insights auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: ManagedProductsService, useValue: managedProductsMock }],
    });
  });

  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("401 on GET /build/managed-products/1/insights without a token", async () => {
    const res = await request(app.getHttpServer()).get("/build/managed-products/1/insights");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("403 on GET /build/managed-products/1/insights without build:managed-products:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/managed-products/1/insights")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("does NOT block GET /build/managed-products/1/insights with build:managed-products:view", async () => {
    managedProductsMock.getProductInsights.mockResolvedValue({
      openTickets: 0,
      closedTickets: 0,
      bugs: 0,
    });
    const token = await signToken({
      permissions: ["build:managed-products:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/managed-products/1/insights")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("GET /build/managed-products/1/insights from a caller in a different tenant yields 404 not 403", async () => {
    managedProductsMock.getProductInsights.mockRejectedValue(
      new NotFoundException("Managed product not found"),
    );
    const token = await signToken({
      orgId: "org_other",
      permissions: ["build:managed-products:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/managed-products/1/insights")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  describe("when the caller's org membership is inactive", () => {
    let inactiveApp: INestApplication;

    beforeAll(async () => {
      inactiveApp = await createE2eApp({
        overrides: [
          {
            provide: MembershipStateService,
            useValue: {
              resolve: async () =>
                ({ active: false, isOwner: false, role: "MEMBER", membershipId: null }),
            } as unknown as MembershipStateService,
          },
          { provide: ManagedProductsService, useValue: managedProductsMock },
        ],
      });
    });

    afterAll(async () => inactiveApp.close());

    it("403 ORG_MEMBERSHIP_INACTIVE on GET /build/managed-products/1/insights", async () => {
      const token = await signToken({
        permissions: ["build:managed-products:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(inactiveApp.getHttpServer())
        .get("/build/managed-products/1/insights")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "ORG_MEMBERSHIP_INACTIVE" });
    });
  });
});
