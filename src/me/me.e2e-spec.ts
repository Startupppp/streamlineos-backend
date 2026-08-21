import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../app.module";
import { AllExceptionsFilter } from "../common/http/all-exceptions.filter";
import { signToken } from "../../test/helpers/sign-token";
import { stubMembershipState } from "../../test/helpers/membership-state";

describe("/me (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await stubMembershipState(
      Test.createTestingModule({ imports: [AppModule] }),
      {
        user_77: { role: "SALES" },
        owner_1: { role: "OWNER", isOwner: true },
        member_1: { role: "SALES" },
      },
    ).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it("401 without a token", async () => {
    const res = await request(app.getHttpServer()).get("/me");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("200 with a valid token, returns the user context resolved from the membership row", async () => {
    const token = await signToken({ sub: "user_77", orgId: "org_3" });
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: "user_77", orgId: "org_3", role: "SALES" });
  });

  it("403 on /me/protected for a non-owner without the crm:leads:delete grant", async () => {
    const token = await signToken({ sub: "member_1" });
    const res = await request(app.getHttpServer())
      .get("/me/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Permission denied" });
  });

  it("200 on /me/protected for an org owner", async () => {
    const token = await signToken({ sub: "owner_1" });
    const res = await request(app.getHttpServer())
      .get("/me/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, userId: "owner_1" });
  });

  it("403 on /me/protected when the token claims ownership the membership row does not grant", async () => {
    const token = await signToken({ sub: "member_1", isOrgOwner: true });
    const res = await request(app.getHttpServer())
      .get("/me/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Permission denied" });
  });
});
