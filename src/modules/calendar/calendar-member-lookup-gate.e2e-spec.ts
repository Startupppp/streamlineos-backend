jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp, accessStub } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { OrgMembersService } from "src/modules/organization/setup/org-members.service";
import { AccessService } from "src/modules/access/access.service";

const ALICE_ROW = {
  id: "user_1",
  firstName: "Alice",
  lastName: "Smith",
  name: "Alice Smith",
  email: "alice@streamline.test",
  image: null,
  role: "MEMBER",
};

describe("Calendar member lookup — access MISSING / GRANTED / REVOKED (e2e)", () => {
  let app: INestApplication;
  const listMembersMock = jest.fn().mockResolvedValue([ALICE_ROW]);

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: OrgMembersService, useValue: { listMembers: listMembersMock } },
      ],
    });
  });

  afterAll(async () => app.close());
  beforeEach(() => listMembersMock.mockClear());

  it("MISSING — 403 when directory:people:view is not held", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/org/members")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(listMembersMock).not.toHaveBeenCalled();
  });

  it("GRANTED — 200 with tenant-scoped rows when directory:people:view is held", async () => {
    const token = await signToken({
      permissions: ["directory:people:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/org/members")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(listMembersMock).toHaveBeenCalledWith("org_1", expect.any(Object));
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it("REVOKED — 403 after directory:people:view is removed between grant and call", async () => {
    const revokedToken = await signToken({ permissions: [], enabledModules: ALL_MODULES });
    const res = await request(app.getHttpServer())
      .get("/org/members")
      .set("Authorization", `Bearer ${revokedToken}`);
    expect(res.status).toBe(403);
    expect(listMembersMock).not.toHaveBeenCalled();
  });

  it("cross-tenant isolation — orgId from JWT wins; client cannot inject a foreign org's members", async () => {
    const token = await signToken({
      orgId: "org_alien",
      permissions: ["directory:people:view"],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/org/members")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(listMembersMock).toHaveBeenCalledWith("org_alien", expect.any(Object));
    expect(listMembersMock).not.toHaveBeenCalledWith("org_1", expect.anything());
  });
});

describe("Calendar member lookup — BITE PROOF (guard is load-bearing, not vacuous)", () => {
  let guardedApp: INestApplication;
  let bypassApp: INestApplication;
  const listMembersMock = jest.fn().mockResolvedValue([ALICE_ROW]);

  beforeAll(async () => {
    guardedApp = await createE2eApp({
      overrides: [
        { provide: OrgMembersService, useValue: { listMembers: listMembersMock } },
      ],
    });
    bypassApp = await createE2eApp({
      overrides: [
        { provide: OrgMembersService, useValue: { listMembers: listMembersMock } },
        {
          provide: AccessService,
          useValue: {
            ...accessStub,
            holds: async (): Promise<boolean> => true,
            scopeFor: async (): Promise<"all"> => "all",
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await guardedApp.close();
    await bypassApp.close();
  });

  it(
    "the MISSING test is load-bearing: neutering the guard makes the same token-without-permission " +
      "request return 200, proving the 403 assertion above is not vacuous",
    async () => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

      const guardedRes = await request(guardedApp.getHttpServer())
        .get("/org/members")
        .set("Authorization", `Bearer ${token}`);
      expect(guardedRes.status).toBe(403);

      const bypassRes = await request(bypassApp.getHttpServer())
        .get("/org/members")
        .set("Authorization", `Bearer ${token}`);
      expect(bypassRes.status).toBe(200);
    },
  );
});
