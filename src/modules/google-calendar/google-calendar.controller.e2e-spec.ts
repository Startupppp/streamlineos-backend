import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { GoogleCalendarModule } from "./google-calendar.module";
import { DrizzleModule } from "../../db/drizzle.module";
import { ConfigModule } from "../../config/config.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";

describe("Google Calendar auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({
      imports: [ConfigModule, DrizzleModule, GoogleCalendarModule],
    }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    return method === "get" ? agent.get(path) : agent.post(path);
  }

  const routes: ReadonlyArray<[Method, string]> = [
    ["post", "/calendar/create-meet"],
    ["get", "/calendar/create-meet"],
    ["post", "/hr/integrations/google-calendar"],
  ];

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
