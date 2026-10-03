import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { RisksService } from "./risks.service";
import { DecisionsService } from "./decisions.service";

const risksSvc = {
  listOrgRisks: jest.fn(),
  listRisks: jest.fn(),
  getRisk: jest.fn(),
  createRisk: jest.fn(),
  updateRisk: jest.fn(),
};

const decisionsSvc = {
  listDecisions: jest.fn(),
  getDecision: jest.fn(),
  createDecision: jest.fn(),
  updateDecision: jest.fn(),
};

describe("ProjectsGovernance risks+decisions auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: RisksService, useValue: risksSvc },
        { provide: DecisionsService, useValue: decisionsSvc },
      ],
    });
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  type Method = "get" | "post" | "patch" | "delete";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
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
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/build/1/risks"],
    ["get", "/build/1/risks/2"],
    ["post", "/build/1/risks"],
    ["patch", "/build/1/risks/2"],
    ["delete", "/build/1/risks/2"],
    ["get", "/build/1/decisions"],
    ["get", "/build/1/decisions/2"],
    ["post", "/build/1/decisions"],
    ["patch", "/build/1/decisions/2"],
    ["delete", "/build/1/decisions/2"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /projects/1/risks without projects:risks:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/risks")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/risks/2 without projects:risks:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/risks/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/risks without projects:risks:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/risks")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "DB failure risk" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/risks/2 without projects:risks:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch("/build/1/risks/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "mitigated" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /projects/1/risks/2 without projects:risks:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .delete("/build/1/risks/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/decisions without projects:decisions:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/decisions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/decisions/2 without projects:decisions:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/decisions/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/decisions without projects:decisions:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/decisions")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Use PostgreSQL over MySQL" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/decisions/2 without projects:decisions:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch("/build/1/decisions/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "accepted" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /projects/1/decisions/2 without projects:decisions:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .delete("/build/1/decisions/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/1/risks with build:risks:view — stub returns list without a DB connection", async () => {
    risksSvc.listRisks.mockResolvedValue({ data: [], hasMore: false, nextCursor: null });
    const token = await signToken({
      permissions: ["build:risks:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/risks")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(risksSvc.listRisks).toHaveBeenCalled();
  });

  it("routes GET /build/risks to the organization-level risk list", async () => {
    risksSvc.listOrgRisks.mockResolvedValue({ data: [], hasMore: false, nextCursor: null });
    const token = await signToken({
      permissions: ["build:risks:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/risks")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(risksSvc.listOrgRisks).toHaveBeenCalled();
    expect(risksSvc.listRisks).not.toHaveBeenCalled();
  });

  it("200 on GET /build/1/decisions with build:decisions:view — stub returns list without a DB connection", async () => {
    decisionsSvc.listDecisions.mockResolvedValue({ data: [], hasMore: false, nextCursor: null });
    const token = await signToken({
      permissions: ["build:decisions:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/decisions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(decisionsSvc.listDecisions).toHaveBeenCalled();
  });
});
