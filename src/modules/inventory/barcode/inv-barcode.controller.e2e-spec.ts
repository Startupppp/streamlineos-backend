import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";
import { stubMembershipState } from "../../../../test/helpers/membership-state";

describe("/inventory/barcode (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const moduleRef = await stubMembershipState(
      Test.createTestingModule({ imports: [AppModule] }),
      {
        owner_1: { role: "OWNER", isOwner: true },
      },
    ).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    token = await signToken({ sub: "owner_1", orgId: "org_inv_01" });
  });

  afterAll(async () => app.close());

  it("401 on GET /inventory/barcode/lookup without token", async () => {
    const res = await request(app.getHttpServer()).get("/inventory/barcode/lookup?code=TEST");
    expect(res.status).toBe(401);
  });

  it("400 when code is missing", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/barcode/lookup")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("returns not_found for unknown code", async () => {
    const res = await request(app.getHttpServer())
      .get("/inventory/barcode/lookup?code=UNKNOWN_BARCODE_12345")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.type).toBe("not_found");
  });
});
