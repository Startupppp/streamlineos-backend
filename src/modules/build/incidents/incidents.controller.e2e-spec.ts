import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { IncidentsService } from "./incidents.service";

const incidentsSvc = {
  listIncidents: jest.fn(),
  getIncident: jest.fn(),
  createIncident: jest.fn(),
  updateIncident: jest.fn(),
  deleteIncident: jest.fn(),
};

describe("ProjectsIncidents auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: IncidentsService, useValue: incidentsSvc },
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
    ["get", "/build/1/incidents"],
    ["get", "/build/1/incidents/2"],
    ["post", "/build/1/incidents"],
    ["patch", "/build/1/incidents/2"],
    ["delete", "/build/1/incidents/2"],
    ["post", "/build/1/incidents/2/updates"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /projects/1/incidents without projects:incidents:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/incidents")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/incidents/2 without projects:incidents:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/incidents/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/incidents without projects:incidents:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "DB replication lag" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/incidents/2 without projects:incidents:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch("/build/1/incidents/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "investigating" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /projects/1/incidents/2 without projects:incidents:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .delete("/build/1/incidents/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/incidents/2/updates without projects:incidents:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/incidents/2/updates")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Investigated root cause" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/1/incidents with build:incidents:view — stub returns list without a DB connection", async () => {
    incidentsSvc.listIncidents.mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
    const token = await signToken({
      permissions: ["build:incidents:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/incidents")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(incidentsSvc.listIncidents).toHaveBeenCalled();
  });

  it("201 on POST /build/1/incidents with build:incidents:manage — stub returns item without a DB connection", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    incidentsSvc.createIncident.mockResolvedValue({ id: 1, orgId: "org-1", projectId: 1, incidentNumber: 1, title: "DB replication lag", description: null, severity: "medium", status: "detected", impact: null, ownerId: null, rootCause: null, customerComms: null, detectedAt: null, respondedAt: null, resolvedAt: null, responseDueAt: null, resolutionDueAt: null, linkedTicketId: null, releaseId: null, createdBy: null, createdAt: now, updatedAt: now, deletedAt: null });
    const token = await signToken({
      permissions: ["build:incidents:manage"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "DB replication lag" });
    expect(res.status).toBe(201);
    expect(incidentsSvc.createIncident).toHaveBeenCalled();
  });
});
