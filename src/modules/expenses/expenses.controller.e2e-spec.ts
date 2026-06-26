import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Expenses auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "delete";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/hr/expenses"],
    ["get", "/hr/expenses/page-data"],
    ["get", "/hr/expenses/report"],
    ["get", "/hr/expenses/export"],
    ["delete", "/hr/expenses/1"],
    ["get", "/hr/expenses/categories"],
    ["post", "/hr/expenses/categories"],
  ];

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "delete":
        return agent.delete(path);
    }
  }

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on POST /hr/expenses/categories without hr:expenses manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/hr/expenses/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Travel" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "RBAC_DENIED",
      verb: "manage",
      subject: "hr:expenses",
    });
  });
});
