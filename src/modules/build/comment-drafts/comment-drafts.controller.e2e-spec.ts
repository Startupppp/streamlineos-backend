import type { INestApplication } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { CommentDraftGeneratorService } from "./comment-draft-generator.service";
import { CommentDraftsService } from "./comment-drafts.service";
import { MembershipStateService } from "../../../common/auth/membership-state.service";

const generatorMock = {
  generate: jest.fn(),
};

const commentDraftsMock = {
  listMine: jest.fn(),
  upsert: jest.fn(),
  recordDraftFailure: jest.fn(),
  deleteAllMine: jest.fn(),
  deleteByTicket: jest.fn(),
  deleteOne: jest.fn(),
};

describe("CommentDrafts generate-draft auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: CommentDraftGeneratorService, useValue: generatorMock },
        { provide: CommentDraftsService, useValue: commentDraftsMock },
      ],
    });
  });

  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("401 on POST /build/comment-drafts/tickets/1/generate-draft without a token", async () => {
    const res = await request(app.getHttpServer()).post(
      "/build/comment-drafts/tickets/1/generate-draft",
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("403 on POST /build/comment-drafts/tickets/1/generate-draft without build:ai:use", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .post("/build/comment-drafts/tickets/1/generate-draft")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST generate-draft when caller holds a neighbouring key but not build:ai:use", async () => {
    const token = await signToken({
      permissions: ["build:tickets:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/build/comment-drafts/tickets/1/generate-draft")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("200 on POST generate-draft with build:ai:use — exact status confirms the endpoint is actually healthy, not merely unauthenticated", async () => {
    generatorMock.generate.mockResolvedValue({
      id: 1,
      orgId: "org_1",
      membershipId: 42,
      ticketId: 1,
      body: "We should extend the session timeout.",
      evidence: null,
      proposedChange: null,
      impact: null,
      confidence: null,
      affectedRecordIds: null,
      retryCount: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      aiUsage: {
        model: "claude-3-haiku",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        credits: 2,
        costUsd: 0.0003,
      },
    });
    const token = await signToken({
      permissions: ["build:ai:use"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/build/comment-drafts/tickets/1/generate-draft")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST generate-draft from a caller in a different tenant yields 404 not 403", async () => {
    generatorMock.generate.mockRejectedValue(new NotFoundException("Ticket not found"));
    const token = await signToken({
      orgId: "org_other",
      permissions: ["build:ai:use"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/build/comment-drafts/tickets/1/generate-draft")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  describe("when the caller's org membership is inactive", () => {
    let inactiveApp: INestApplication;

    beforeAll(async () => {
      inactiveApp = await createE2eApp({
        overrides: [
          {
            provide: MembershipStateService,
            useValue: {
              resolve: async () =>
                ({ active: false, isOwner: false, role: "MEMBER", membershipId: null }),
            } as unknown as MembershipStateService,
          },
          { provide: CommentDraftGeneratorService, useValue: generatorMock },
          { provide: CommentDraftsService, useValue: commentDraftsMock },
        ],
      });
    });

    afterAll(async () => inactiveApp.close());

    it("403 ORG_MEMBERSHIP_INACTIVE on POST generate-draft", async () => {
      const token = await signToken({
        permissions: ["build:ai:use"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(inactiveApp.getHttpServer())
        .post("/build/comment-drafts/tickets/1/generate-draft")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "ORG_MEMBERSHIP_INACTIVE" });
    });
  });
});

describe("CommentDrafts listMine auth/RBAC and ticket-field contract (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: CommentDraftGeneratorService, useValue: generatorMock },
        { provide: CommentDraftsService, useValue: commentDraftsMock },
      ],
    });
  });

  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("401 on GET /build/comment-drafts/mine without a token", async () => {
    const res = await request(app.getHttpServer()).get("/build/comment-drafts/mine");
    expect(res.status).toBe(401);
  });

  it("403 on GET /build/comment-drafts/mine without build:tickets:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/comment-drafts/mine")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("200 on GET /build/comment-drafts/mine with build:tickets:view and response includes ticket object — D1 fix verified", async () => {
    commentDraftsMock.listMine.mockResolvedValue([
      {
        id: 1,
        orgId: "org_1",
        membershipId: 42,
        ticketId: 99,
        body: "draft body",
        createdAt: new Date(),
        updatedAt: new Date(),
        ticket: {
          id: 99,
          type: "BUG",
          title: "Fix crash",
          projectId: 1,
          status: "IN_PROGRESS",
          ticketNumber: 5,
          projectKey: "BLD",
          priority: "HIGH",
          projectName: "BuildOS",
          assignee: null,
        },
      },
    ]);
    const token = await signToken({
      permissions: ["build:tickets:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/comment-drafts/mine")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty("ticket");
    expect(res.body[0].ticket.title).toBe("Fix crash");
  });

  it("200 empty array on GET /build/comment-drafts/mine when there are no drafts", async () => {
    commentDraftsMock.listMine.mockResolvedValue([]);
    const token = await signToken({
      permissions: ["build:tickets:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/comment-drafts/mine")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
