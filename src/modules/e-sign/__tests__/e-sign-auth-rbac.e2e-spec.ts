import { INestApplication, NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { SignPublicService } from "../sign-public.service";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";

const publicSigningStub = {
  getSession: jest.fn().mockRejectedValue(new NotFoundException()),
  getDocumentPreview: jest.fn().mockRejectedValue(new NotFoundException()),
  requestOtp: jest.fn().mockRejectedValue(new NotFoundException()),
  authenticate: jest.fn().mockRejectedValue(new NotFoundException()),
  acceptConsent: jest.fn().mockRejectedValue(new NotFoundException()),
  adoptSignature: jest.fn().mockRejectedValue(new NotFoundException()),
  setFieldValue: jest.fn().mockRejectedValue(new NotFoundException()),
  complete: jest.fn().mockRejectedValue(new NotFoundException()),
  decline: jest.fn().mockRejectedValue(new NotFoundException()),
};

const rateLimitStub = { check: jest.fn().mockResolvedValue({ allowed: true }) };

describe("SignOS auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: SignPublicService, useValue: publicSigningStub },
        { provide: RateLimitService, useValue: rateLimitStub },
      ],
    });
  });

  afterAll(async () => app.close());

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
    ["get", "/sign/envelopes/1/audit"],
    ["get", "/sign/envelopes/1/certificate"],
    ["get", "/sign/envelopes/1/final-pdf"],
    ["post", "/sign/envelopes/1/regenerate-certificate"],
    ["post", "/sign/documents/upload"],
    ["get", "/sign/envelopes/1/documents"],
    ["get", "/sign/documents/1/preview"],
    ["delete", "/sign/documents/1"],
    ["post", "/sign/envelopes/1/fields"],
    ["get", "/sign/envelopes/1/fields"],
    ["patch", "/sign/fields/1"],
    ["delete", "/sign/fields/1"],
    ["post", "/sign/envelopes/1/recipients"],
    ["get", "/sign/envelopes/1/recipients"],
    ["patch", "/sign/recipients/1"],
    ["delete", "/sign/recipients/1"],
    ["post", "/sign/templates"],
    ["post", "/sign/envelopes/1/save-as-template"],
    ["get", "/sign/templates"],
    ["get", "/sign/templates/1"],
    ["patch", "/sign/templates/1"],
    ["post", "/sign/templates/1/duplicate"],
    ["post", "/sign/templates/1/create-envelope"],
    ["post", "/sign/templates/1/publish-public-form"],
    ["post", "/sign/bulk-send/jobs"],
    ["get", "/sign/bulk-send/jobs"],
    ["get", "/sign/bulk-send/jobs/1"],
    ["post", "/sign/bulk-send/jobs/1/cancel"],
    ["get", "/sign/bulk-send/jobs/1/error-report"],
    ["get", "/sign/admin/settings"],
    ["patch", "/sign/admin/settings"],
    ["get", "/sign/admin/watermark-policies"],
    ["get", "/sign/admin/watermark-policies/1"],
    ["post", "/sign/admin/watermark-policies"],
    ["patch", "/sign/admin/watermark-policies/1"],
    ["delete", "/sign/admin/watermark-policies/1"],
    ["post", "/sign/admin/run-reminder-sweep"],
    ["post", "/sign/admin/run-expiration-sweep"],
    ["get", "/sign/reports/dashboard"],
    ["get", "/sign/reports/summary"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it.each(protectedRoutes)("402 on %s %s when the sign module is not enabled", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await callRoute(method, path, token);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "MODULE_NOT_ENABLED", details: { moduleKey: "sign" } });
  });

  it.each(protectedRoutes)("403 on %s %s with no sign permission grants", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await callRoute(method, path, token);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  describe("public signing routes never require auth", () => {
    const publicRoutes: ReadonlyArray<[Method, string]> = [
      ["get", "/public/sign/nonexistent-token/session"],
      ["get", "/public/sign/nonexistent-token/documents/1/preview"],
      ["post", "/public/sign/nonexistent-token/request-otp"],
      ["post", "/public/sign/nonexistent-token/auth"],
      ["post", "/public/sign/nonexistent-token/consent"],
      ["post", "/public/sign/nonexistent-token/complete"],
      ["post", "/public/sign/nonexistent-token/decline"],
    ];

    it.each(publicRoutes)("never 401s on %s %s", async (method, path) => {
      const res = await callRoute(method, path);
      expect(res.status).not.toBe(401);
      expect([404, 400, 403]).toContain(res.status);
    });
  });
});
