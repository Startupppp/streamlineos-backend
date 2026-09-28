import type { INestApplication } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { FilesService } from "./files.service";
import { MembershipStateService } from "../../../common/auth/membership-state.service";

type Method = "get" | "post" | "delete";

function buildCall(app: INestApplication, method: Method, path: string): request.Test {
  const agent = request(app.getHttpServer());
  switch (method) {
    case "get":
      return agent.get(path);
    case "post":
      return agent.post(path);
    case "delete":
      return agent.delete(path);
  }
}

const filesMock = {
  listFiles: jest.fn(),
  uploadFile: jest.fn(),
  getSignedUrl: jest.fn(),
  softDeleteFile: jest.fn(),
};

describe("Files auth/RBAC (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [{ provide: FilesService, useValue: filesMock }],
    });
  });

  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  const protectedRoutes: ReadonlyArray<[Method, string]> = [
    ["get", "/build/1/files"],
    ["post", "/build/1/files"],
    ["get", "/build/1/files/2/url"],
    ["delete", "/build/1/files/2"],
  ];

  it.each(protectedRoutes)("401 on %s %s without a token", async (method, path) => {
    const res = await buildCall(app, method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("403 on GET /build/1/files without build:files:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/1/files")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on GET /build/1/files/2/url without build:files:view", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/build/1/files/2/url")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on POST /build/1/files without build:files:manage", async () => {
    const token = await signToken({
      permissions: ["build:files:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/files")
      .set("Authorization", `Bearer ${token}`)
      .send({ fileName: "design.png", mimeType: "image/png", contentBase64: "AAAA" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("403 on DELETE /build/1/files/2 without build:files:manage", async () => {
    const token = await signToken({
      permissions: ["build:files:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .delete("/build/1/files/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN" });
  });

  it("200 on GET /build/1/files with build:files:view — contract-conforming list page", async () => {
    filesMock.listFiles.mockResolvedValue({
      data: [],
      pagination: { limit: 25, hasMore: false, nextCursor: null },
    });
    const token = await signToken({
      permissions: ["build:files:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/files")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("201 on POST /build/1/files with build:files:manage — valid body reaches the service", async () => {
    filesMock.uploadFile.mockResolvedValue({
      id: 1,
      orgId: "test-org",
      projectId: 1,
      uploadedByMembershipId: 7,
      fileName: "file.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      createdAt: new Date(),
      deletedAt: null,
    });
    const token = await signToken({
      permissions: ["build:files:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/files")
      .set("Authorization", `Bearer ${token}`)
      .send({ fileName: "file.png", mimeType: "image/png", contentBase64: "AAAA" });
    expect(res.status).toBe(201);
  });

  it("200 on GET /build/1/files/2/url with build:files:view — fileIdParams includes projectId so params validation passes", async () => {
    filesMock.getSignedUrl.mockResolvedValue({
      url: "https://cdn.example.com/signed",
      expiresIn: 120,
    });
    const token = await signToken({
      permissions: ["build:files:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/files/2/url")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("204 on DELETE /build/1/files/2 with build:files:manage — fileIdParams includes projectId so params validation passes", async () => {
    filesMock.softDeleteFile.mockResolvedValue(undefined);
    const token = await signToken({
      permissions: ["build:files:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .delete("/build/1/files/2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it("GET /build/1/files from a caller in a different tenant yields 404 not 403", async () => {
    filesMock.listFiles.mockRejectedValue(new NotFoundException("Project not found"));
    const token = await signToken({
      orgId: "org_other",
      permissions: ["build:files:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/files")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
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
          { provide: FilesService, useValue: filesMock },
        ],
      });
    });

    afterAll(async () => inactiveApp.close());

    it("403 ORG_MEMBERSHIP_INACTIVE on GET /build/1/files", async () => {
      const token = await signToken({
        permissions: ["build:files:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(inactiveApp.getHttpServer())
        .get("/build/1/files")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "ORG_MEMBERSHIP_INACTIVE" });
    });
  });
});
