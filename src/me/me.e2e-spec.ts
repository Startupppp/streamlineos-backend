import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../app.module";
import { AllExceptionsFilter } from "../common/http/all-exceptions.filter";
import { signToken } from "../../test/helpers/sign-token";
import { stubMembershipState } from "../../test/helpers/membership-state";
import { installFixtureRegionRegistry } from "../../test/helpers/e2e-app";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.types";

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

    /**
     * `org_3` is not a row in `organizations`, so `regionForOrg` refuses it and
     * every request that gets past the guards dies unmapped. `createE2eApp`
     * stubs the placement for exactly this reason; this suite builds its own
     * module, so it has to ask.
     */
    installFixtureRegionRegistry(moduleRef.get<Db>(DRIZZLE));

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

  it("reports ownership from the membership row for an owner", async () => {
    const token = await signToken({ sub: "owner_1" });
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: "owner_1", role: "OWNER", isOrgOwner: true });
  });

  it("ignores a token that claims ownership the membership row does not grant", async () => {
    const token = await signToken({ sub: "member_1", isOrgOwner: true });
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: "member_1", role: "SALES", isOrgOwner: false });
  });

  it("never echoes the token's permission claim back as resolved access", async () => {
    const token = await signToken({ sub: "member_1", permissions: ["crm:leads:delete"] });
    const res = await request(app.getHttpServer()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    /**
     * Absent, not empty — which is the stronger version of the same claim.
     *
     * This asserted `permissions: []` when `/me` still returned the field.
     * It no longer does: access is resolved per request from the database, and
     * a `/me` that carried a permission list at all would be a list somebody
     * would eventually trust. So the check is that the key is gone and the
     * claim went nowhere, rather than that it came back empty.
     */
    expect(res.body).not.toHaveProperty("permissions");
    expect(JSON.stringify(res.body)).not.toContain("crm:leads:delete");
    expect(res.body).toMatchObject({ userId: "member_1", role: "SALES" });
  });
});
