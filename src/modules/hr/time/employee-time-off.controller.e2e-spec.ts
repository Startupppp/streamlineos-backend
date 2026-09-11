jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp, accessStub } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AccessService } from "src/modules/access/access.service";
import { LeavesPageService } from "src/modules/hr/time/leaves-page.service";
import { LeavesService } from "src/modules/hr/time/leaves.service";
import { LeavesWriteService } from "src/modules/hr/time/leaves-write.service";
import { WfhService } from "src/modules/hr/time/wfh.service";

/**
 * PRD-C115 — representative E2E for `/me/time-off` (seven routes).
 *
 * The third self-service controller, and the only one whose routes are NOT all
 * behind one permission: five carry `self:leaves` and the two `wfh` routes
 * carry `self:attendance`. That split is the interesting property — holding one
 * must not open the other — and nothing exercised it before this file.
 *
 * Every handler derives its subject from `@CurrentUser()`; the client never
 * names one. The cases below prove it by pushing a foreign `userId` at each
 * route and asserting the service is still called for the caller.
 */

const SELF = "user_1";
const VICTIM = "user_victim";
const LEAVES_PERMISSION = "self:leaves";
const WFH_PERMISSION = "self:attendance";

type Method = "get" | "post" | "patch";

interface RouteCase {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
  permission: string;
  successStatus: number;
}

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

const CREATE_LEAVE_BODY = {
  leaveTypeId: 4,
  startDate: tomorrow(),
  endDate: tomorrow(),
  reason: "Family commitment out of town.",
};

const CREATE_WFH_BODY = {
  date: tomorrow(),
  reason: "Fibre install at home.",
  approverId: "user_manager",
};

const ROUTES: readonly RouteCase[] = [
  { method: "get", path: "/me/time-off", permission: LEAVES_PERMISSION, successStatus: 200 },
  {
    method: "get",
    path: "/me/time-off/requests?limit=20",
    permission: LEAVES_PERMISSION,
    successStatus: 200,
  },
  {
    method: "get",
    path: "/me/time-off/team-calendar",
    permission: LEAVES_PERMISSION,
    successStatus: 200,
  },
  {
    method: "post",
    path: "/me/time-off",
    body: CREATE_LEAVE_BODY,
    permission: LEAVES_PERMISSION,
    successStatus: 201,
  },
  {
    method: "patch",
    path: "/me/time-off/9/cancel",
    permission: LEAVES_PERMISSION,
    successStatus: 200,
  },
  { method: "get", path: "/me/time-off/wfh", permission: WFH_PERMISSION, successStatus: 200 },
  {
    method: "post",
    path: "/me/time-off/wfh",
    body: CREATE_WFH_BODY,
    permission: WFH_PERMISSION,
    successStatus: 201,
  },
];

const LEAVE_REQUEST_ROW = {
  id: 9,
  orgId: "org_1",
  userId: SELF,
  workerId: null,
  workerEngagementId: null,
  leaveTypeId: 4,
  startDate: "2026-09-10",
  endDate: "2026-09-10",
  reason: "Family commitment out of town.",
  priority: "NORMAL",
  status: "PENDING",
  approverId: "user_manager",
  rejectionReason: null,
  managerComment: null,
  attachmentUrl: null,
  isHalfDay: false,
  halfDayPeriod: null,
  coveringEmployeeId: null,
  lopDays: "0",
  approverMembershipId: 2,
  userMembershipId: 1,
  coveringEmployeeMembershipId: null,
  rowVersion: 1,
  createdByMembershipId: 1,
  updatedByMembershipId: null,
  createdAt: new Date("2026-09-08T09:00:00.000Z"),
  updatedAt: new Date("2026-09-08T09:00:00.000Z"),
};

const LEAVE_REQUEST_WITH_RELATIONS = {
  ...LEAVE_REQUEST_ROW,
  leaveType: { id: 4, name: "Casual Leave", daysPerYear: 12 },
  approver: { id: "user_manager", name: "Manager One", firstName: "Manager", lastName: "One" },
};

const LEAVES_THIS_WEEK_ITEM = {
  ...LEAVE_REQUEST_ROW,
  status: "APPROVED",
  leaveType: { id: 4, name: "Casual Leave" },
  user: {
    id: SELF,
    name: "Self User",
    firstName: "Self",
    lastName: "User",
    image: null,
    designation: "Engineer",
  },
};

const WFH_REQUEST_ROW = {
  id: 5,
  orgId: "org_1",
  userId: SELF,
  date: "2026-09-10",
  reason: "Fibre install at home.",
  status: "PENDING",
  approverId: "user_manager",
  approverMembershipId: 2,
  userMembershipId: 1,
  rejectionReason: null,
  createdAt: new Date("2026-09-08T09:00:00.000Z"),
  updatedAt: new Date("2026-09-08T09:00:00.000Z"),
};

describe("EmployeeTimeOffController — /me/time-off (e2e)", () => {
  let app: INestApplication;

  const leavesPage = {
    pageData: jest.fn().mockResolvedValue({
      balances: [{ id: 1, leaveTypeId: 4, balance: "10", typeName: "Casual Leave", daysPerYear: 12 }],
      types: [{ id: 4, orgId: "org_1", name: "Casual Leave", daysPerYear: 12, carryForward: false }],
      joiningDate: "2025-01-01",
      approvers: [{ id: "user_manager", name: "Manager One", email: "manager@example.com" }],
    }),
  };
  const leaves = {
    my: jest.fn().mockResolvedValue({
      data: [LEAVE_REQUEST_WITH_RELATIONS],
      pageInfo: { limit: 20, hasMore: false, nextCursor: null },
    }),
    thisWeek: jest.fn().mockResolvedValue([LEAVES_THIS_WEEK_ITEM]),
  };
  const leavesWrite = {
    create: jest.fn().mockResolvedValue({ success: true }),
    cancel: jest.fn().mockResolvedValue({ ok: true }),
  };
  const wfh = {
    list: jest.fn().mockResolvedValue([WFH_REQUEST_ROW]),
    create: jest.fn().mockResolvedValue({ success: true }),
  };

  const allServiceFns = [
    leavesPage.pageData,
    leaves.my,
    leaves.thisWeek,
    leavesWrite.create,
    leavesWrite.cancel,
    wfh.list,
    wfh.create,
  ];

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: LeavesPageService, useValue: leavesPage },
        { provide: LeavesService, useValue: leaves },
        { provide: LeavesWriteService, useValue: leavesWrite },
        { provide: WfhService, useValue: wfh },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    for (const fn of allServiceFns) fn.mockClear();
  });

  function noServiceWasCalled(): void {
    for (const fn of allServiceFns) expect(fn).not.toHaveBeenCalled();
  }

  function send(route: RouteCase, token?: string, path = route.path): request.Test {
    const agent = request(app.getHttpServer());
    const req =
      route.method === "get"
        ? agent.get(path)
        : route.method === "post"
          ? agent.post(path)
          : agent.patch(path);
    if (token) req.set("Authorization", `Bearer ${token}`);
    return route.body ? req.send(route.body) : req;
  }

  it.each(ROUTES.map((r) => [r.method, r.path, r] as const))(
    "401 on %s %s without a token",
    async (_method, _path, route) => {
      const res = await send(route);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
      noServiceWasCalled();
    },
  );

  it.each(ROUTES.map((r) => [r.method, r.path, r] as const))(
    "403 on %s %s for a member holding no self permission at all",
    async (_method, _path, route) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await send(route, token);
      expect(res.status).toBe(403);
      noServiceWasCalled();
    },
  );

  it.each(ROUTES.map((r) => [r.method, r.path, r] as const))(
    "%s %s succeeds once its own permission is held",
    async (_method, _path, route) => {
      const token = await signToken({
        permissions: [route.permission],
        enabledModules: ALL_MODULES,
      });
      const res = await send(route, token);
      expect(res.status).toBe(route.successStatus);
    },
  );

  it.each(ROUTES.map((r) => [r.method, r.path, r] as const))(
    "PERMISSION SPLIT: %s %s stays 403 for the OTHER self permission",
    async (_method, _path, route) => {
      const other =
        route.permission === LEAVES_PERMISSION ? WFH_PERMISSION : LEAVES_PERMISSION;
      const token = await signToken({
        permissions: [other],
        enabledModules: ALL_MODULES,
      });
      const res = await send(route, token);
      expect(res.status).toBe(403);
      noServiceWasCalled();
    },
  );

  it("SUBJECT: every route resolves the caller from the token, never from the request", async () => {
    const token = await signToken({
      permissions: [LEAVES_PERMISSION, WFH_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const auth = `Bearer ${token}`;
    const agent = request(app.getHttpServer());

    await agent.get("/me/time-off").set("Authorization", auth);
    expect(leavesPage.pageData).toHaveBeenCalledWith("org_1", SELF);

    await agent.get("/me/time-off/requests?limit=20").set("Authorization", auth);
    const myArgs = leaves.my.mock.calls[0] as unknown[];
    expect(myArgs[0]).toBe("org_1");
    expect(myArgs[1]).toBe(SELF);

    await agent.get("/me/time-off/wfh").set("Authorization", auth);
    expect(wfh.list).toHaveBeenCalledWith("org_1", SELF);

    await agent
      .post("/me/time-off")
      .set("Authorization", auth)
      .send(CREATE_LEAVE_BODY);
    const createArgs = leavesWrite.create.mock.calls[0] as unknown[];
    expect(createArgs[0]).toMatchObject({ orgId: "org_1", userId: SELF });

    await agent.patch("/me/time-off/9/cancel").set("Authorization", auth);
    const cancelArgs = leavesWrite.cancel.mock.calls[0] as unknown[];
    expect(cancelArgs[0]).toMatchObject({ orgId: "org_1", userId: SELF });
    expect(cancelArgs[1]).toBe(9);
  });

  it("PRIVACY: a client-supplied userId cannot widen the request list to another member", async () => {
    const token = await signToken({
      permissions: [LEAVES_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get(`/me/time-off/requests?limit=20&userId=${VICTIM}`)
      .set("Authorization", `Bearer ${token}`);

    expect([200, 400]).toContain(res.status);
    if (res.status === 400) {
      expect(leaves.my).not.toHaveBeenCalled();
      return;
    }
    const myArgs = leaves.my.mock.calls[0] as unknown[];
    expect(myArgs[1]).toBe(SELF);
    expect(JSON.stringify(myArgs)).not.toContain(VICTIM);
  });

  it("PRIVACY: a client-supplied author on the create body cannot file leave for someone else", async () => {
    const token = await signToken({
      permissions: [LEAVES_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/me/time-off")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...CREATE_LEAVE_BODY, userId: VICTIM });

    expect([201, 400]).toContain(res.status);
    if (res.status === 400) {
      expect(leavesWrite.create).not.toHaveBeenCalled();
      return;
    }
    const createArgs = leavesWrite.create.mock.calls[0] as unknown[];
    expect(createArgs[0]).toMatchObject({ userId: SELF });
    expect(JSON.stringify(createArgs[1])).not.toContain(VICTIM);
  });

  it("CANCEL: a leave the caller does not own is 404, not a silent success", async () => {
    leavesWrite.cancel.mockResolvedValueOnce({ ok: false });
    const token = await signToken({
      permissions: [LEAVES_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .patch("/me/time-off/9/cancel")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("CROSS-TENANT: the org comes from the token, so a second tenant reads its own rows", async () => {
    const token = await signToken({
      orgId: "org_alien",
      sub: "user_alien",
      permissions: [LEAVES_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/me/time-off")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(leavesPage.pageData).toHaveBeenCalledWith("org_alien", "user_alien");
    expect(leavesPage.pageData).not.toHaveBeenCalledWith("org_1", expect.anything());
  });
});

describe("EmployeeTimeOffController — BITE PROOF (the self permissions are load-bearing)", () => {
  let guarded: INestApplication;
  let ungated: INestApplication;
  const leavesPage = {
    pageData: jest.fn().mockResolvedValue({
      balances: [],
      types: [],
      joiningDate: null,
      approvers: [],
    }),
  };

  beforeAll(async () => {
    guarded = await createE2eApp({
      overrides: [{ provide: LeavesPageService, useValue: leavesPage }],
    });
    ungated = await createE2eApp({
      overrides: [
        { provide: LeavesPageService, useValue: leavesPage },
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
    await guarded.close();
    await ungated.close();
  });

  it("the same permissionless token is 403 through the real guard and 200 through a neutered one", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const denied = await request(guarded.getHttpServer())
      .get("/me/time-off")
      .set("Authorization", `Bearer ${token}`);
    expect(denied.status).toBe(403);

    const allowed = await request(ungated.getHttpServer())
      .get("/me/time-off")
      .set("Authorization", `Bearer ${token}`);
    expect(allowed.status).toBe(200);
  });
});
