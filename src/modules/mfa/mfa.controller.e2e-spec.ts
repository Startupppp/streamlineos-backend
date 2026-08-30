import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { MfaService } from "./mfa.service";

const stubMfa = {
  setup: jest.fn().mockResolvedValue({ secret: "TOTP_SECRET", uri: "otpauth://..." }),
  verify: jest.fn().mockResolvedValue({ enabled: true }),
  disable: jest.fn().mockResolvedValue({ disabled: true }),
  status: jest.fn().mockResolvedValue({ enabled: false }),
  reset: jest.fn().mockResolvedValue({ reset: true }),
};

describe("MFA controller auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: MfaService, useValue: stubMfa }],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("401 on POST /auth/mfa/setup without a token", async () => {
    const res = await request(app.getHttpServer()).post("/auth/mfa/setup");
    expect(res.status).toBe(401);
  });

  it("401 on GET /auth/mfa/status without a token", async () => {
    const res = await request(app.getHttpServer()).get("/auth/mfa/status");
    expect(res.status).toBe(401);
  });

  it("401 on POST /auth/mfa/reset without a token", async () => {
    const res = await request(app.getHttpServer()).post("/auth/mfa/reset");
    expect(res.status).toBe(401);
  });

  it("200 on POST /auth/mfa/setup for any authenticated member (universal)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/auth/mfa/setup")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("200 on GET /auth/mfa/status for any authenticated member (universal)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/auth/mfa/status")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("200 on POST /auth/mfa/disable with valid body (universal)", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/auth/mfa/disable")
      .set("Authorization", `Bearer ${token}`)
      .send({ token: "123456" });
    expect(res.status).toBe(200);
  });

  it("400 on POST /auth/mfa/verify with invalid body", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/auth/mfa/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("403 on POST /auth/mfa/reset without settings:mfa permission", async () => {
    const token = await signToken({
      permissions: [],
      enabledModules: [...ALL_MODULES, "settings"],
    });
    const res = await request(app.getHttpServer())
      .post("/auth/mfa/reset")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "user_other" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("200 on POST /auth/mfa/reset with settings:mfa permission", async () => {
    const token = await signToken({
      permissions: ["settings:mfa"],
      enabledModules: [...ALL_MODULES, "settings"],
    });
    const res = await request(app.getHttpServer())
      .post("/auth/mfa/reset")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: "user_other" });
    expect(res.status).toBe(200);
  });
});
