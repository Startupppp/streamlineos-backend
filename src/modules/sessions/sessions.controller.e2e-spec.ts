import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("Sessions auth (e2e)", () => {
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

  const routes: ReadonlyArray<["get" | "delete", string]> = [
    ["get", "/hr/sessions"],
    ["delete", "/hr/sessions"],
    ["delete", "/hr/sessions/some-session-id"],
  ];

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const agent = request(app.getHttpServer());
    const res = await (method === "get" ? agent.get(path) : agent.delete(path));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
