import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import request from "supertest";
import { DrizzleModule } from "../../db/drizzle.module";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { PublicModule } from "./public.module";

describe("Public auth (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({
      imports: [DrizzleModule, PublicModule],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch";

  interface PublicCase {
    method: Method;
    path: string;
    body?: Record<string, unknown>;
  }

  function call(c: PublicCase): request.Test {
    const agent = request(app.getHttpServer());
    switch (c.method) {
      case "get":
        return agent.get(c.path);
      case "post":
        return agent.post(c.path).send(c.body ?? {});
      case "patch":
        return agent.patch(c.path).send(c.body ?? {});
    }
  }

  const publicRoutes: ReadonlyArray<PublicCase> = [
    { method: "get", path: "/public/roadmap" },
    { method: "post", path: "/public/roadmap/vote", body: {} },
    { method: "post", path: "/public/roadmap/feedback", body: {} },
    { method: "get", path: "/public/kb" },
    { method: "post", path: "/public/kb/getting-started/feedback", body: {} },
    { method: "post", path: "/public/nps/sometoken", body: {} },
    { method: "get", path: "/public/careers/acme/jobs/not-a-number" },
    {
      method: "post",
      path: "/public/careers/acme/jobs/not-a-number/apply",
      body: {},
    },
    { method: "post", path: "/public/intake/not-a-number", body: {} },
    { method: "post", path: "/public/waitlist", body: {} },
  ];

  it.each(publicRoutes)(
    "does NOT require auth on $method $path",
    async (c: PublicCase) => {
      const res = await call(c);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    },
  );
});
