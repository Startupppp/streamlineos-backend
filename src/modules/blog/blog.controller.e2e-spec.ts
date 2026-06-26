import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Blog auth/RBAC (e2e)", () => {
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

  const authedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/blog/posts"],
    ["post", "/blog/posts"],
    ["get", "/blog/posts/abc"],
    ["patch", "/blog/posts/abc"],
    ["delete", "/blog/posts/abc"],
    ["post", "/blog/categories"],
    ["patch", "/blog/categories/abc"],
    ["delete", "/blog/categories/abc"],
  ];

  it.each(authedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /blog/posts without blog:posts manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/blog/posts")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "Forbidden",
      code: "RBAC_DENIED",
      verb: "manage",
      subject: "blog:posts",
    });
  });

  it("403 on POST /blog/categories without blog:categories manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/blog/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "News" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "RBAC_DENIED",
      verb: "manage",
      subject: "blog:categories",
    });
  });

  it("does NOT require auth on GET /blog/categories (public endpoint)", async () => {
    const res = await callRoute("get", "/blog/categories");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT require auth on GET /blog/feed (public endpoint)", async () => {
    const res = await callRoute("get", "/blog/feed");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
