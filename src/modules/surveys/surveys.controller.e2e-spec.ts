import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";

const SURVEY_ID = "00000000-0000-0000-0000-000000000001";

describe("Surveys module auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

  type Method = "get" | "post" | "patch" | "delete";

  function call(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get": return agent.get(path);
      case "post": return agent.post(path);
      case "patch": return agent.patch(path);
      case "delete": return agent.delete(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/surveys"],
    ["post", "/surveys"],
    ["get", `/surveys/${SURVEY_ID}/analytics/overview`],
    ["get", `/surveys/${SURVEY_ID}/automations`],
    ["post", `/surveys/${SURVEY_ID}/automations`],
    ["get", `/surveys/${SURVEY_ID}/collectors`],
    ["post", `/surveys/${SURVEY_ID}/collectors`],
    ["get", `/surveys/${SURVEY_ID}/participants`],
    ["post", `/surveys/${SURVEY_ID}/participants`],
    ["post", "/surveys/live-sessions"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
  });

  it.each(protectedRoutes)("403 on %s %s without any survey permission", async (method, path) => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await call(method, path).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /surveys without surveys:update permission", async () => {
    const token = await signToken({
      permissions: ["surveys:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/surveys")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "New Survey" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /surveys/:id/automations without surveys:automations:manage", async () => {
    const token = await signToken({
      permissions: ["surveys:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post(`/surveys/${SURVEY_ID}/automations`)
      .set("Authorization", `Bearer ${token}`)
      .send({ trigger: "completed" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /surveys/live-sessions without surveys:live:host", async () => {
    const token = await signToken({
      permissions: ["surveys:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/surveys/live-sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ surveyId: SURVEY_ID });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("GET /public/surveys/:token is public (no auth required)", async () => {
    const res = await request(app.getHttpServer())
      .get("/public/surveys/some-token");
    expect(res.status).not.toBe(401);
  });

  it("cross-tenant: another org survey id returns 404 not 403", async () => {
    const token = await signToken({
      permissions: ["surveys:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get(`/surveys/${SURVEY_ID}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });
});
