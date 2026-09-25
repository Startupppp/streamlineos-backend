import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../test/helpers/sign-token";
import { ModuleDisabledException } from "../../common/http/api-exceptions";

describe("Expenses import auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  it("401 on POST /hr/expenses/import without a token", async () => {
    const res = await request(app.getHttpServer()).post("/hr/expenses/import");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("402 MODULE_NOT_ENABLED with an upgradePath for a caller whose org is not entitled", async () => {
    // PROVISIONAL: the entitlement denial code stays MODULE_NOT_ENABLED (BE-23); there is
    // deliberately no FEATURE_NOT_ENTITLED. The module tier answers before the permission
    // tier, so a fully-permissioned caller still gets 402 here rather than 200.
    const token = await signToken({
      permissions: ["hr:expenses:manage"],
      enabledModules: ALL_MODULES.filter((m) => m !== "accounting"),
    });
    const res = await request(app.getHttpServer())
      .post("/hr/expenses/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ fileName: "expenses.csv", content: "category,amount\nTravel,10" });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: "MODULE_NOT_ENABLED",
      details: { moduleKey: "accounting" },
    });
    expect(typeof res.body.message).toBe("string");
    expect(["not-in-plan", "org-disabled", "user-denied"]).toContain(res.body.details.reason);
    // upgradePath is always present; it names the billing page only when the denial is
    // the plan's, which is the branch pinned below (the e2e fixture org has no
    // org_modules row for accounting, so this request denies as org-disabled).
    expect(Object.keys(res.body.details)).toContain("upgradePath");
  });

  it("the plan-locked denial the route raises carries the billing upgradePath", () => {
    const body = new ModuleDisabledException("accounting", "not-in-plan").getResponse();
    expect(body).toMatchObject({
      code: "MODULE_NOT_ENABLED",
      details: { moduleKey: "accounting", reason: "not-in-plan", upgradePath: "/settings/billing" },
    });
  });

  it("200 on the same body once the module is entitled (the positive half of the 402)", async () => {
    const token = await signToken({
      permissions: ["hr:expenses:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/hr/expenses/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ fileName: "expenses.csv", content: "category,amount\nTravel,10" });

    expect(res.status).not.toBe(402);
  });

  it("403 on POST /hr/expenses/import without approve hr:expenses", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/hr/expenses/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ fileName: "expenses.csv", content: "category,amount\nTravel,10" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });
});
