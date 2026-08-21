import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("Directory auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
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

  const PERSON_ID = "00000000-0000-0000-0000-000000000001";
  const WORKER_ID = "00000000-0000-0000-0000-000000000002";
  const ENGAGEMENT_ID = "00000000-0000-0000-0000-000000000003";

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/directory/people"],
    ["get", `/directory/people/${PERSON_ID}`],
    ["post", "/directory/people"],
    ["patch", `/directory/people/${PERSON_ID}`],
    ["delete", `/directory/people/${PERSON_ID}`],
    ["get", "/directory/workers"],
    ["get", `/directory/workers/${WORKER_ID}`],
    ["post", "/directory/workers"],
    ["get", `/directory/workers/${WORKER_ID}/engagements`],
    ["post", `/directory/workers/${WORKER_ID}/engagements`],
    ["patch", `/directory/engagements/${ENGAGEMENT_ID}`],
    ["post", `/directory/engagements/${ENGAGEMENT_ID}/cancel`],
    ["post", `/directory/engagements/${ENGAGEMENT_ID}/terminate`],
  ];

  it.each(protectedRoutes)(
    "401 on %s %s without a token",
    async (method, path) => {
      const res = await callRoute(method, path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    },
  );

  it("403 on POST /directory/people without directory:people:create permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/directory/people")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Alice Example" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /directory/workers without directory:workers:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/directory/workers")
      .set("Authorization", `Bearer ${token}`)
      .send({ personId: PERSON_ID });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /directory/engagements/:id/terminate without directory:workers:terminate permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post(`/directory/engagements/${ENGAGEMENT_ID}/terminate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "test" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on POST /directory/engagements/:id/cancel without directory:workers:manage permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post(`/directory/engagements/${ENGAGEMENT_ID}/cancel`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on GET /directory/people without directory:people:view permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/directory/people")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });

  it("403 on GET /directory/workers without directory:workers:view permission", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/directory/workers")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Permission denied" });
  });
});
