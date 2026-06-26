import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";

describe("AuditLog auth/RBAC (e2e)", () => {
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

  const routes: ReadonlyArray<string> = [
    "/audit-log",
    "/audit-log/actions",
    "/audit-log/target-types",
  ];

  it.each(routes)("401 on GET %s without a token", async (path) => {
    const res = await request(app.getHttpServer()).get(path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it.each(routes)("403 on GET %s without audit-log read", async (path) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "Forbidden",
      code: "RBAC_DENIED",
      verb: "read",
      subject: "audit-log",
    });
  });
});
