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
      .send({ name: "design.png", url: "https://cdn.example.com/file.png" });
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

  it("does NOT block GET /build/1/files with build:files:view", async () => {
    filesMock.listFiles.mockResolvedValue({ data: [], hasMore: false, total: 0 });
    const token = await signToken({
      permissions: ["build:files:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/files")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT block POST /build/1/files with build:files:manage", async () => {
    filesMock.uploadFile.mockResolvedValue({ id: 1, name: "file.png" });
    const token = await signToken({
      permissions: ["build:files:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/files")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "file.png", url: "https://cdn.example.com/file.png" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
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
