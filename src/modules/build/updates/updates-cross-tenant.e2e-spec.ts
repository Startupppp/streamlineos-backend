import type { INestApplication } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { DRIZZLE } from "src/db/drizzle.constants";
import { UpdatesService } from "./updates.service";
import { MembershipStateService } from "../../../common/auth/membership-state.service";

const updatesMock = {
  listUpdates: jest.fn(),
  createUpdate: jest.fn(),
  softDeleteUpdate: jest.fn(),
  editUpdate: jest.fn(),
};

describe("ProjectUpdates cross-tenant and no-membership denial (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: DRIZZLE, useValue: {} },
        { provide: UpdatesService, useValue: updatesMock },
      ],
    });
  });

  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("GET /build/1/updates from a caller in a different tenant yields 404 not 403", async () => {
    updatesMock.listUpdates.mockRejectedValue(new NotFoundException("Project not found"));
    const token = await signToken({
      orgId: "org_other",
      permissions: ["build:updates:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/updates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("POST /build/1/updates from a caller in a different tenant yields 404 not 403", async () => {
    updatesMock.createUpdate.mockRejectedValue(new NotFoundException("Project not found"));
    const token = await signToken({
      orgId: "org_other",
      permissions: ["build:updates:manage"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/build/1/updates")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Sprint is on track." });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("200 on GET /build/1/updates for an authorized caller — stub returns list without a DB connection", async () => {
    updatesMock.listUpdates.mockResolvedValue({ items: [], nextCursor: null });
    const token = await signToken({
      permissions: ["build:updates:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/build/1/updates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(updatesMock.listUpdates).toHaveBeenCalled();
  });

  describe("when the caller's org membership is inactive", () => {
    let inactiveApp: INestApplication;

    beforeAll(async () => {
      inactiveApp = await createE2eApp({
        overrides: [
          { provide: DRIZZLE, useValue: {} },
          {
            provide: MembershipStateService,
            useValue: {
              resolve: async () =>
                ({ active: false, isOwner: false, role: "MEMBER", membershipId: null }),
            } as unknown as MembershipStateService,
          },
          { provide: UpdatesService, useValue: updatesMock },
        ],
      });
    });

    afterAll(async () => inactiveApp.close());

    it("403 ORG_MEMBERSHIP_INACTIVE on GET /build/1/updates", async () => {
      const token = await signToken({
        permissions: ["build:updates:view"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(inactiveApp.getHttpServer())
        .get("/build/1/updates")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "ORG_MEMBERSHIP_INACTIVE" });
    });

    it("403 ORG_MEMBERSHIP_INACTIVE on POST /build/1/updates", async () => {
      const token = await signToken({
        permissions: ["build:updates:manage"],
        enabledModules: ALL_MODULES,
      });
      const res = await request(inactiveApp.getHttpServer())
        .post("/build/1/updates")
        .set("Authorization", `Bearer ${token}`)
        .send({ body: "Sprint is on track." });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "ORG_MEMBERSHIP_INACTIVE" });
    });
  });
});
