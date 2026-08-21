import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "../../../../test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";

describe("/inventory/barcode (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await createE2eApp();
    token = await signToken({
      sub: "owner_1",
      orgId: "org_inv_01",
      isOrgOwner: true,
      enabledModules: ["inventory"],
    });
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
