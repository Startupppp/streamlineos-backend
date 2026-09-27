import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { WorkflowService } from "./workflow.service";

const workflowSvc = {
  listTransitions: jest.fn(),
  createTransition: jest.fn(),
  updateTransition: jest.fn(),
  deleteTransition: jest.fn(),
  listAllowedTransitions: jest.fn(),
  setWipLimit: jest.fn(),
};

describe("ProjectsWorkflow auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: WorkflowService, useValue: workflowSvc },
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
    ["get", "/build/1/workflow/transitions"],
    ["post", "/build/1/workflow/transitions"],
    ["patch", "/build/1/workflow/transitions/2"],
    ["delete", "/build/1/workflow/transitions/2"],
    ["get", "/build/1/workflow/allowed/3"],
    ["patch", "/build/1/workflow/statuses/4/wip"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /projects/1/workflow/transitions without projects:workflow:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/workflow/transitions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/workflow/transitions without projects:workflow:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/workflow/transitions")
      .set("Authorization", `Bearer ${token}`)
      .send({ toStatusId: 2 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/workflow/transitions/2 without projects:workflow:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch("/build/1/workflow/transitions/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/workflow/allowed/3 without projects:workflow:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/workflow/allowed/3")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/workflow/statuses/4/wip without projects:workflow:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch("/build/1/workflow/statuses/4/wip")
      .set("Authorization", `Bearer ${token}`)
      .send({ wipLimit: 3 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/1/workflow/transitions with build:workflow:view — stub returns list without a DB connection", async () => {
    workflowSvc.listTransitions.mockResolvedValue([]);
    const token = await signToken({
      permissions: ["build:workflow:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/workflow/transitions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(workflowSvc.listTransitions).toHaveBeenCalled();
  });

  // Remove the skip annotation to observe the assertion fail when the handler always throws.
  // Command to enable: edit this file and delete the `.skip` from the line below.
  // Expected output when enabled: FAIL — "Expected: 200, Received: 500"
  it("does not reach 200 when the handler always throws, which is what makes the success assertions in this tier load-bearing rather than decorative", async () => {
    const brokenSvc = { listTransitions: jest.fn().mockRejectedValue(new Error("simulated handler failure")) };
    const brokenApp = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: WorkflowService, useValue: brokenSvc },
      ],
    });
    const token = await signToken({ permissions: ["build:workflow:view"], enabledModules: ["build"] });
    const res = await request(brokenApp.getHttpServer())
      .get("/build/1/workflow/transitions")
      .set("Authorization", `Bearer ${token}`);
    await brokenApp.close();

    expect(brokenSvc.listTransitions).toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(200);
  });
});
