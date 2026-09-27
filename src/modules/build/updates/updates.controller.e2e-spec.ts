import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { UpdatesService } from "./updates.service";

const updatesSvc = {
  listUpdates: jest.fn(),
  createUpdate: jest.fn(),
  editUpdate: jest.fn(),
  softDeleteUpdate: jest.fn(),
};

describe("ProjectUpdates auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: UpdatesService, useValue: updatesSvc },
      ],
    });
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  type Method = "get" | "post" | "delete" | "patch";

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "delete":
        return agent.delete(path);
      case "patch":
        return agent.patch(path);
    }
  }

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/build/1/updates"],
    ["post", "/build/1/updates"],
    ["delete", "/build/1/updates/2"],
    ["patch", "/build/1/updates/2"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /build/1/updates without build:updates:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .get("/build/1/updates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /build/1/updates without build:updates:manage", async () => {
    const token = await signToken({ permissions: ["build:updates:view"], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .post("/build/1/updates")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Sprint is on track." });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /build/1/updates/2 without build:updates:manage", async () => {
    const token = await signToken({ permissions: [], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .delete("/build/1/updates/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /build/1/updates/2 without build:updates:manage", async () => {
    const token = await signToken({ permissions: ["build:updates:view"], enabledModules: ["build"] });
    const res = await request(app.getHttpServer())
      .patch("/build/1/updates/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Patched update." });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/1/updates with build:updates:view — stub returns list without a DB connection", async () => {
    updatesSvc.listUpdates.mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
    const token = await signToken({
      permissions: ["build:updates:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/updates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(updatesSvc.listUpdates).toHaveBeenCalled();
  });

  it("200 on PATCH /build/1/updates/2 with build:updates:manage — stub returns item without a DB connection", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    updatesSvc.editUpdate.mockResolvedValue({ id: 2, orgId: "org-1", projectId: 1, authorMembershipId: 1, authorName: "Test User", body: "Patched update.", wins: null, risks: null, next: null, citations: null, status: "published", audience: "internal", createdAt: now, updatedAt: now, deletedAt: null });
    const token = await signToken({
      permissions: ["build:updates:manage"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .patch("/build/1/updates/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Patched update." });
    expect(res.status).toBe(200);
    expect(updatesSvc.editUpdate).toHaveBeenCalled();
  });
});
