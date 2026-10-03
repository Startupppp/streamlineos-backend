import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "../../../../test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { ApprovalsService } from "./approvals.service";
import { ApprovalsReadService } from "./approvals-read.service";
import { BuildInboxCountService } from "./build-inbox-count.service";

const approvalsReadSvc = {
  listApprovals: jest.fn(),
  getApproval: jest.fn(),
  getInbox: jest.fn(),
};

const approvalsWriteSvc = {
  createApproval: jest.fn(),
  decideApproval: jest.fn(),
  updateApproval: jest.fn(),
};

const inboxCountSvc = {
  countPending: jest.fn(),
};

describe("ProjectsApprovals auth/RBAC (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: ApprovalsReadService, useValue: approvalsReadSvc },
        { provide: ApprovalsService, useValue: approvalsWriteSvc },
        { provide: BuildInboxCountService, useValue: inboxCountSvc },
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
    ["get", "/build/approvals/inbox"],
    ["get", "/build/approvals/inbox/count"],
    ["get", "/build/1/approvals"],
    ["get", "/build/1/approvals/2"],
    ["post", "/build/1/approvals"],
    ["patch", "/build/1/approvals/2/decide"],
    ["patch", "/build/1/approvals/2"],
    ["delete", "/build/1/approvals/2"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });

  it("403 on GET /projects/approvals/inbox without projects:approvals:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/approvals/inbox")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /build/approvals/inbox/count without build:approvals:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/approvals/inbox/count")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on GET /projects/1/approvals without projects:approvals:view ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/1/approvals")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on POST /projects/1/approvals without projects:approvals:request ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/build/1/approvals")
      .set("Authorization", `Bearer ${token}`)
      .send({ entityType: "ticket", entityId: 1, title: "Review", approverId: "user-2" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/approvals/2/decide without projects:approvals:decide ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch("/build/1/approvals/2/decide")
      .set("Authorization", `Bearer ${token}`)
      .send({ decision: "approved" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on PATCH /projects/1/approvals/2 without projects:approvals:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .patch("/build/1/approvals/2")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "escalated" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("403 on DELETE /projects/1/approvals/2 without projects:approvals:manage ability", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .delete("/build/1/approvals/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
  });

  it("200 on GET /build/1/approvals with build:approvals:view — stub returns list without a DB connection", async () => {
    approvalsReadSvc.listApprovals.mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
    const token = await signToken({
      permissions: ["build:approvals:view"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/approvals")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(approvalsReadSvc.listApprovals).toHaveBeenCalled();
  });

  it("201 on POST /build/1/approvals with build:approvals:request and Idempotency-Key — stub returns item without a DB connection", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    approvalsWriteSvc.createApproval.mockResolvedValue({ id: 1, orgId: "org-1", projectId: 1, entityType: "task", entityId: 1, title: "Approval", reason: null, requestedById: null, approverMembershipId: null, status: "requested", level: 1, dueAt: null, decisionComment: null, decidedAt: null, createdBy: null, createdAt: now, updatedAt: now, deletedAt: null });
    const token = await signToken({
      permissions: ["build:approvals:request"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/approvals")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "e2e-approval-create-success-1")
      .send({ entityType: "task", entityId: 1, title: "Review", approverId: "user-2" });
    expect(res.status).toBe(201);
    expect(approvalsWriteSvc.createApproval).toHaveBeenCalled();
  });

  it("rejects a create without an Idempotency-Key with 400 because build.approval.create is a required fence", async () => {
    const token = await signToken({
      permissions: ["build:approvals:request"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/approvals")
      .set("Authorization", `Bearer ${token}`)
      .send({ entityType: "task", entityId: 1, title: "Review", approverId: "user-2" });
    expect(res.status).toBe(400);
  });

  it("rejects an entityType outside approval_entity_type with 400 before reaching the project lookup", async () => {
    const token = await signToken({
      permissions: ["build:approvals:request"],
      enabledModules: ["build"],
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/approvals")
      .set("Authorization", `Bearer ${token}`)
      .send({ entityType: "ticket", entityId: 1, title: "Review", approverId: "user-2" });
    expect(res.status).toBe(400);
  });
});
