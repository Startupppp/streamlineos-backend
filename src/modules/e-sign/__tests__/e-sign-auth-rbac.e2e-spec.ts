import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { eq } from "drizzle-orm";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
import { signToken } from "../../../../test/helpers/sign-token";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { organizations, users } from "../../../db/schema";

const P = "e2e-signos-rbac-";
const ORG_ID = `${P}org`;
const USER_ID = `${P}user`;

describe("SignOS auth/RBAC (e2e)", () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    db = app.get(DRIZZLE);

    await db.delete(users).where(eq(users.id, USER_ID));
    await db.delete(organizations).where(eq(organizations.id, ORG_ID));
    await db.insert(organizations).values({ id: ORG_ID, name: "E2E SignOS RBAC Org", slug: `${P}slug`, ownerMembershipId: 9001 });
    await db.insert(users).values({ id: USER_ID, email: `${P}user@example.com` });
  }, 30_000);

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, USER_ID));
    await db.delete(organizations).where(eq(organizations.id, ORG_ID));
    await app.close();
  }, 30_000);

  type Method = "get" | "post" | "patch" | "delete";

  function callRoute(method: Method, path: string, token?: string): request.Test {
    const agent = request(app.getHttpServer());
    const req = ((): request.Test => {
      switch (method) {
        case "get":
          return agent.get(path);
        case "post":
          return agent.post(path);
        case "patch":
          return agent.patch(path);
        case "delete":
          return agent.delete(path);
      }
    })();
    return token ? req.set("Authorization", `Bearer ${token}`).send({}) : req.send({});
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    // envelopes
    ["post", "/sign/envelopes"],
    ["get", "/sign/envelopes"],
    ["get", "/sign/envelopes/1"],
    ["patch", "/sign/envelopes/1"],
    ["post", "/sign/envelopes/1/validate"],
    ["post", "/sign/envelopes/1/send"],
    ["post", "/sign/envelopes/1/void"],
    ["post", "/sign/envelopes/1/correct"],
    ["post", "/sign/envelopes/1/resend"],
    ["post", "/sign/envelopes/1/send-reminder"],
    ["post", "/sign/envelopes/1/extend-expiration"],
    // certificates / audit
    ["get", "/sign/envelopes/1/audit"],
    ["get", "/sign/envelopes/1/certificate"],
    ["get", "/sign/envelopes/1/final-pdf"],
    ["post", "/sign/envelopes/1/regenerate-certificate"],
    // documents
    ["post", "/sign/documents/upload"],
    ["get", "/sign/envelopes/1/documents"],
    ["get", "/sign/documents/1/preview"],
    ["delete", "/sign/documents/1"],
    // fields
    ["post", "/sign/envelopes/1/fields"],
    ["get", "/sign/envelopes/1/fields"],
    ["patch", "/sign/fields/1"],
    ["delete", "/sign/fields/1"],
    // recipients
    ["post", "/sign/envelopes/1/recipients"],
    ["get", "/sign/envelopes/1/recipients"],
    ["patch", "/sign/recipients/1"],
    ["delete", "/sign/recipients/1"],
    // templates
    ["post", "/sign/templates"],
    ["post", "/sign/envelopes/1/save-as-template"],
    ["get", "/sign/templates"],
    ["get", "/sign/templates/1"],
    ["patch", "/sign/templates/1"],
    ["post", "/sign/templates/1/duplicate"],
    ["post", "/sign/templates/1/create-envelope"],
    ["post", "/sign/templates/1/publish-public-form"],
    // bulk send
    ["post", "/sign/bulk-send/jobs"],
    ["get", "/sign/bulk-send/jobs"],
    ["get", "/sign/bulk-send/jobs/1"],
    ["post", "/sign/bulk-send/jobs/1/cancel"],
    ["get", "/sign/bulk-send/jobs/1/error-report"],
    // admin
    ["get", "/sign/admin/settings"],
    ["patch", "/sign/admin/settings"],
    ["get", "/sign/admin/watermark-policies"],
    ["get", "/sign/admin/watermark-policies/1"],
    ["post", "/sign/admin/watermark-policies"],
    ["patch", "/sign/admin/watermark-policies/1"],
    ["delete", "/sign/admin/watermark-policies/1"],
    ["post", "/sign/admin/run-reminder-sweep"],
    ["post", "/sign/admin/run-expiration-sweep"],
    // reports
    ["get", "/sign/reports/dashboard"],
    ["get", "/sign/reports/summary"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
  });

  it.each(protectedRoutes)(
    "403 on %s %s for an authenticated user with zero SignOS permission grants",
    async (method, path) => {
      const token = await signToken({
        sub: USER_ID,
        orgId: ORG_ID,
        isOrgOwner: false,
        permissions: [],
        enabledModules: ["sign"],
      });
      const res = await callRoute(method, path, token);
      expect(res.status).toBe(403);
    },
  );

  describe("public signing routes never require auth", () => {
    const publicRoutes: ReadonlyArray<[Method, string]> = [
      ["get", "/public/sign/nonexistent-token/session"],
      ["get", "/public/sign/nonexistent-token/documents/1/preview"],
      ["post", "/public/sign/nonexistent-token/request-otp"],
      ["post", "/public/sign/nonexistent-token/auth"],
      ["post", "/public/sign/nonexistent-token/consent"],
      ["post", "/public/sign/nonexistent-token/complete"],
      ["post", "/public/sign/nonexistent-token/decline"],
      ["get", "/public/sign/forms/nonexistent-slug"],
    ];

    it.each(publicRoutes)("never 401s on %s %s, even with a garbage token", async (method, path) => {
      const res = await callRoute(method, path);
      expect(res.status).not.toBe(401);
      expect([404, 400, 403]).toContain(res.status);
    });
  });
});
