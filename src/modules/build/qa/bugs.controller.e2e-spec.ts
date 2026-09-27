import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { BugsService } from "./bugs.service";
import { TestManagementService } from "./test-management.service";
import { TestRunsService } from "./test-runs.service";

const bugsSvc = {
  listBugs: jest.fn(),
  getBug: jest.fn(),
  createBug: jest.fn(),
  updateBug: jest.fn(),
  deleteBug: jest.fn(),
};

const testMgmtSvc = {
  listSuites: jest.fn(),
  createSuite: jest.fn(),
  updateSuite: jest.fn(),
  deleteSuite: jest.fn(),
  listCases: jest.fn(),
  getCase: jest.fn(),
  createCase: jest.fn(),
  updateCase: jest.fn(),
  deleteCase: jest.fn(),
};

const testRunsSvc = {
  listTestRuns: jest.fn(),
  getTestRun: jest.fn(),
  createTestRun: jest.fn(),
  updateTestRun: jest.fn(),
  deleteTestRun: jest.fn(),
  updateResult: jest.fn(),
  attachBugToResult: jest.fn(),
};

describe("ProjectsQA bugs auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: BugsService, useValue: bugsSvc },
        { provide: TestManagementService, useValue: testMgmtSvc },
        { provide: TestRunsService, useValue: testRunsSvc },
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
    ["get", "/build/1/bugs"],
    ["get", "/build/1/bugs/2"],
    ["post", "/build/1/bugs"],
    ["patch", "/build/1/bugs/2"],
    ["delete", "/build/1/bugs/2"],
    ["get", "/build/1/test-suites"],
    ["post", "/build/1/test-suites"],
    ["patch", "/build/1/test-suites/2"],
    ["delete", "/build/1/test-suites/2"],
    ["get", "/build/1/test-cases"],
    ["get", "/build/1/test-cases/2"],
    ["post", "/build/1/test-cases"],
    ["patch", "/build/1/test-cases/2"],
    ["delete", "/build/1/test-cases/2"],
    ["get", "/build/1/test-runs"],
    ["get", "/build/1/test-runs/2"],
    ["post", "/build/1/test-runs"],
    ["patch", "/build/1/test-runs/2"],
    ["delete", "/build/1/test-runs/2"],
    ["patch", "/build/1/test-runs/2/results/3"],
    ["post", "/build/1/test-runs/2/results/3/bug"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /projects/1/bugs without projects:bugs:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/bugs")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/bugs/2 without projects:bugs:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/bugs/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/bugs without projects:bugs:create ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/bugs")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Login button crash" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/bugs/2 without projects:bugs:update ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch("/build/1/bugs/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "fixed" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /projects/1/bugs/2 without projects:bugs:delete ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .delete("/build/1/bugs/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/test-suites without projects:qa:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/test-suites")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/test-suites without projects:qa:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/test-suites")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Smoke Tests" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/test-cases without projects:qa:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/test-cases")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/test-cases without projects:qa:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/test-cases")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Verify login flow" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/test-runs without projects:qa:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/test-runs")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Sprint 1 Run", caseIds: [] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/test-runs/2/results/3 without projects:qa:execute ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch("/build/1/test-runs/2/results/3")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "passed" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/1/bugs with build:bugs:view — stub returns list without a DB connection", async () => {
    bugsSvc.listBugs.mockResolvedValue([]);
    const token = await signToken({
      permissions: ["build:bugs:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/bugs")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(bugsSvc.listBugs).toHaveBeenCalled();
  });

  it("200 on GET /build/1/test-suites with build:qa:view — stub returns list without a DB connection", async () => {
    testMgmtSvc.listSuites.mockResolvedValue([]);
    const token = await signToken({
      permissions: ["build:qa:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/test-suites")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(testMgmtSvc.listSuites).toHaveBeenCalled();
  });
});
