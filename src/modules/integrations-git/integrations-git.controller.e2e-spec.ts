import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import request from "supertest";
import { DrizzleModule } from "../../db/drizzle.module";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { IntegrationsGitModule } from "./integrations-git.module";

describe("IntegrationsGit auth (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({
      imports: [DrizzleModule, IntegrationsGitModule],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it("does NOT require auth on POST /integrations/git/webhook", async () => {
    const res = await request(app.getHttpServer())
      .post("/integrations/git/webhook?connectionId=not-a-number")
      .send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("acknowledges an unverifiable webhook without touching the DB", async () => {
    const res = await request(app.getHttpServer())
      .post("/integrations/git/webhook?connectionId=not-a-number")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
