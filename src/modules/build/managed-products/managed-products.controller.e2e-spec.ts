import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";

describe("ManagedProducts auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

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
    ["get", `/projects/managed-products/${PRODUCT_ID}`],
    ["post", "/build/managed-products"],
    ["patch", `/projects/managed-products/${PRODUCT_ID}`],
    ["delete", `/projects/managed-products/${PRODUCT_ID}`],
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

  it("403 on PATCH /projects/managed-products/:id without projects:managed-products:update permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch(`/projects/managed-products/${PRODUCT_ID}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Product" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /projects/managed-products/:id without projects:managed-products:delete permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .delete(`/projects/managed-products/${PRODUCT_ID}`)
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

  it("403 on GET /projects/managed-products/:id without projects:managed-products:view permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get(`/projects/managed-products/${PRODUCT_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
