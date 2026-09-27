import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { ManagedProductsService } from "./managed-products.service";

const managedProductsSvc = {
  listManagedProducts: jest.fn(),
  getManagedProduct: jest.fn(),
  createManagedProduct: jest.fn(),
  updateManagedProduct: jest.fn(),
  deleteManagedProduct: jest.fn(),
};

describe("ManagedProducts auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: ManagedProductsService, useValue: managedProductsSvc },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  type Method = "get" | "post" | "patch" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
      case "delete":
        return agent.delete(path);
    }
  }

  const PRODUCT_ID = "1";

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/build/managed-products"],
    ["get", `/build/managed-products/${PRODUCT_ID}`],
    ["post", "/build/managed-products"],
    ["patch", `/build/managed-products/${PRODUCT_ID}`],
    ["delete", `/build/managed-products/${PRODUCT_ID}`],
  ];

  it.each(protectedRoutes)(
    "401 on %s %s without a token",
    async (method, path) => {
      const res = await callRoute(method, path);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
    },
  );

  it("403 on POST /projects/managed-products without projects:managed-products:create permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/managed-products")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Product Alpha" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /build/managed-products/:id without projects:managed-products:update permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch(`/build/managed-products/${PRODUCT_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Product" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /build/managed-products/:id without projects:managed-products:delete permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .delete(`/build/managed-products/${PRODUCT_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/managed-products without projects:managed-products:view permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/managed-products")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /build/managed-products/:id without projects:managed-products:view permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get(`/build/managed-products/${PRODUCT_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/managed-products with build:managed-products:view — stub returns list without a DB connection", async () => {
    managedProductsSvc.listManagedProducts.mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
    const token = await signToken({
      permissions: ["build:managed-products:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/managed-products")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(managedProductsSvc.listManagedProducts).toHaveBeenCalled();
  });
});
