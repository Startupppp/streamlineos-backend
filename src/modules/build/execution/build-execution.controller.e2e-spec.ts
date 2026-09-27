import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { CyclesService } from "./cycles.service";

const cyclesSvc = {
  listCycles: jest.fn(),
  getCycle: jest.fn(),
  createCycle: jest.fn(),
  updateCycle: jest.fn(),
  deleteCycle: jest.fn(),
};

describe("ProjectsExecution auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: CyclesService, useValue: cyclesSvc },
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
    ["get", "/build/1/sprints"],
    ["post", "/build/1/sprints"],
    ["get", "/build/1/sprints/1"],
    ["patch", "/build/1/sprints/1"],
    ["get", "/build/1/cycles"],
    ["post", "/build/1/cycles"],
    ["patch", "/build/1/cycles/1"],
    ["delete", "/build/1/cycles/1"],
    ["get", "/build/1/modules"],
    ["post", "/build/1/modules"],
    ["patch", "/build/1/modules/1"],
    ["delete", "/build/1/modules/1"],
    ["get", "/build/1/epics"],
    ["post", "/build/1/epics"],
    ["get", "/build/1/milestones"],
    ["post", "/build/1/milestones"],
    ["patch", "/build/1/milestones/1"],
    ["delete", "/build/1/milestones/1"],
    ["get", "/build/1/intake"],
    ["post", "/build/1/intake"],
    ["patch", "/build/1/intake/1"],
    ["get", "/build/1/views"],
    ["post", "/build/1/views"],
    ["patch", "/build/1/views/1"],
    ["delete", "/build/1/views/1"],
    ["get", "/build/1/whiteboards"],
    ["post", "/build/1/whiteboards"],
    ["get", "/build/1/whiteboards/1"],
    ["patch", "/build/1/whiteboards/1"],
    ["delete", "/build/1/whiteboards/1"],
    ["get", "/build/time-entries"],
    ["get", "/build/time-entries/team"],
    ["patch", "/build/time-entries/1"],
    ["delete", "/build/time-entries/1"],
    ["patch", "/build/time-entries/1/approve"],
    ["patch", "/build/time-entries/1/reject"],
    ["get", "/build/billing-summary"],
    ["get", "/build/1/tickets/1/time-entries"],
    ["post", "/build/1/tickets/1/time-entries"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("402 MODULE_NOT_ENABLED on POST /projects/1/sprints when projects module is off", async () => {
    const token = await signToken({ permissions: [], enabledModules: [] });
    const res = await request(app.getHttpServer())
      .post("/build/1/sprints")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: "MODULE_NOT_ENABLED", details: { moduleKey: "build" } });
  });

  it("403 on POST /projects/1/sprints without projects:sprints manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/sprints")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/time-entries/team without projects:timesheets manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/time-entries/team")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/time-entries/1/approve without projects:timesheets manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch("/build/time-entries/1/approve")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/1/cycles with build:cycles:view — stub returns list without a DB connection", async () => {
    cyclesSvc.listCycles.mockResolvedValue({ items: [], nextCursor: null });
    const token = await signToken({
      permissions: ["build:cycles:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/cycles")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(cyclesSvc.listCycles).toHaveBeenCalled();
  });
});
