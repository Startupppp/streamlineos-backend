import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../app.module";
import { AllExceptionsFilter } from "../common/http/all-exceptions.filter";
import { signToken } from "../../test/helpers/sign-token";

describe("/me (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it("401 without a token", async () => {
    const res = await request(app.getHttpServer()).get("/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("200 with a valid token, returns the user context", async () => {
    const token = await signToken({ sub: "user_77", orgId: "org_3", role: "SALES" });
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: "user_77", orgId: "org_3", role: "SALES" });
  });

  it("403 RBAC_DENIED on /me/protected without the permission", async () => {
    const token = await signToken({ permissions: ["crm:leads:read"], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/me/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden", code: "RBAC_DENIED", verb: "delete", subject: "crm:leads" });
  });

  it("200 on /me/protected with the permission", async () => {
    const token = await signToken({ permissions: ["crm:leads:delete"], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .get("/me/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
