jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createE2eApp, accessStub } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AccessService } from "src/modules/access/access.service";
import { AttendanceService } from "src/modules/hr/time/attendance.service";
import { AttendanceRegularizationService } from "src/modules/hr/time/attendance-regularization.service";

/**
 * PRD-C115 — representative E2E for `/me/attendance` (ten routes).
 *
 * Attendance is the self-service surface with the largest blast radius: a
 * dropped `user.userId` on any of these handlers is a cross-user read of
 * somebody's punch record. `attendance-read.service.ts` is the only thing
 * standing between that and a leak, and until this file nothing exercised the
 * controller at all.
 *
 * Three traps are pinned deliberately:
 *  - the four `@Idempotent` writes 400 WITHOUT an `Idempotency-Key` header, and
 *    the failure reads like body validation, so every write here sends one;
 *  - the `self*` query schemas are `.strict()`, so a supplied `userId` is a 400
 *    rather than a silently ignored parameter — that is a stronger guarantee
 *    than stripping and it is worth pinning;
 *  - the subject every handler passes downstream comes from `@CurrentUser()`.
 */

const SELF = "user_1";
const VICTIM = "user_victim";
const SELF_PERMISSION = "self:attendance";
const CROSS_TENANT_IDEMPOTENCY_KEY = "11111111-2222-4333-8444-555555555555";

type Method = "get" | "post";

interface RouteCase {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
  idempotent?: boolean;
  service: "attendance" | "regularizations";
}

const ROUTES: readonly RouteCase[] = [
  { method: "get", path: "/me/attendance/status", service: "attendance" },
  { method: "post", path: "/me/attendance/check-in", body: {}, idempotent: true, service: "attendance" },
  { method: "post", path: "/me/attendance/check-out", body: {}, idempotent: true, service: "attendance" },
  { method: "post", path: "/me/attendance/break", idempotent: true, service: "attendance" },
  { method: "get", path: "/me/attendance/logs?year=2026&month=9", service: "attendance" },
  { method: "get", path: "/me/attendance/history?page=1&limit=20", service: "attendance" },
  { method: "get", path: "/me/attendance/monthly?year=2026&month=9", service: "attendance" },
  { method: "get", path: "/me/attendance/heatmap?year=2026", service: "attendance" },
  { method: "get", path: "/me/attendance/holidays", service: "attendance" },
  {
    method: "post",
    path: "/me/attendance/regularizations",
    body: {},
    service: "regularizations",
  },
];

function regularizationBody(): Record<string, unknown> {
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return {
    attendanceDate: day,
    requestedCheckIn: `${day}T09:00:00.000Z`,
    requestedCheckOut: `${day}T18:00:00.000Z`,
    reason: "Badge reader was offline that morning.",
  };
}

function bodyFor(route: RouteCase): Record<string, unknown> | undefined {
  if (route.path.endsWith("/regularizations")) return regularizationBody();
  return route.body;
}

describe("EmployeeAttendanceController — /me/attendance (e2e)", () => {
  let app: INestApplication;

  const attendance = {
    status: jest.fn().mockResolvedValue({ status: "OFFLINE" }),
    checkIn: jest.fn().mockResolvedValue({ ok: true }),
    checkOut: jest.fn().mockResolvedValue({ ok: true }),
    toggleBreak: jest.fn().mockResolvedValue({ ok: true }),
    logs: jest.fn().mockResolvedValue([]),
    history: jest.fn().mockResolvedValue({ data: [], pagination: null }),
    monthly: jest.fn().mockResolvedValue({ days: [] }),
    heatmap: jest.fn().mockResolvedValue({ days: [] }),
    listHolidays: jest.fn().mockResolvedValue([]),
  };
  const regularizations = { create: jest.fn().mockResolvedValue({ id: 3 }) };

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: AttendanceService, useValue: attendance },
        { provide: AttendanceRegularizationService, useValue: regularizations },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    for (const fn of Object.values(attendance)) fn.mockClear();
    regularizations.create.mockClear();
  });

  function noServiceWasCalled(): void {
    for (const fn of Object.values(attendance)) expect(fn).not.toHaveBeenCalled();
    expect(regularizations.create).not.toHaveBeenCalled();
  }

  function send(route: RouteCase, token?: string): request.Test {
    const agent = request(app.getHttpServer());
    const req = route.method === "get" ? agent.get(route.path) : agent.post(route.path);
    if (token) req.set("Authorization", `Bearer ${token}`);
    /*
     * A FRESH key per request. The fence hashes method, params, query and body
     * alongside the command name, so one shared constant makes the second
     * fenced route a same-key-different-request collision and the interceptor
     * answers 422 before the handler runs — which reads exactly like a broken
     * endpoint. The replay contract itself is asserted separately below.
     */
    if (route.idempotent) req.set("Idempotency-Key", randomUUID());
    const body = bodyFor(route);
    return body ? req.send(body) : req;
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
    "403 on %s %s for a member who does not hold self:attendance",
    async (_method, _path, route) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await send(route, token);
      expect(res.status).toBe(403);
      noServiceWasCalled();
    },
  );

  it.each(ROUTES.map((r) => [r.method, r.path, r] as const))(
    "2xx on %s %s once self:attendance is held",
    async (_method, _path, route) => {
      const token = await signToken({
        permissions: [SELF_PERMISSION],
        enabledModules: ALL_MODULES,
      });
      const res = await send(route, token);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    },
  );

  it("SUBJECT: every read resolves the caller from the token, never from the request", async () => {
    const token = await signToken({
      permissions: [SELF_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const agent = request(app.getHttpServer());
    const auth = `Bearer ${token}`;

    await agent.get("/me/attendance/status").set("Authorization", auth);
    expect(attendance.status).toHaveBeenCalledWith("org_1", SELF);

    await agent
      .get("/me/attendance/history?page=1&limit=20")
      .set("Authorization", auth);
    expect(attendance.history).toHaveBeenCalledWith("org_1", SELF, 1, 20);

    await agent.get("/me/attendance/monthly?year=2026&month=9").set("Authorization", auth);
    const monthlyArgs = attendance.monthly.mock.calls[0] as unknown[];
    expect(monthlyArgs[1]).toBe(SELF);
    expect(monthlyArgs[0]).toMatchObject({ orgId: "org_1", userId: SELF });

    await agent.get("/me/attendance/heatmap?year=2026").set("Authorization", auth);
    const heatmapArgs = attendance.heatmap.mock.calls[0] as unknown[];
    expect(heatmapArgs[1]).toBe(SELF);
  });

  it.each([
    ["logs", "/me/attendance/logs?year=2026&month=9"],
    ["monthly", "/me/attendance/monthly?year=2026&month=9"],
    ["heatmap", "/me/attendance/heatmap?year=2026"],
  ])(
    "PRIVACY: %s rejects a client-supplied userId outright — the self schema is strict",
    async (_name, path) => {
      const token = await signToken({
        permissions: [SELF_PERMISSION],
        enabledModules: ALL_MODULES,
      });
      const res = await request(app.getHttpServer())
        .get(`${path}&userId=${VICTIM}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(400);
      noServiceWasCalled();
    },
  );

  it("IDEMPOTENCY: a write without an Idempotency-Key is refused before it reaches the service", async () => {
    const token = await signToken({
      permissions: [SELF_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/me/attendance/check-in")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(attendance.checkIn).not.toHaveBeenCalled();
  });

  it("IDEMPOTENCY: a retried punch replays instead of punching twice, and a reused key on a different route is refused", async () => {
    const token = await signToken({
      permissions: [SELF_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const auth = `Bearer ${token}`;
    const key = randomUUID();

    const first = await request(app.getHttpServer())
      .post("/me/attendance/check-in")
      .set("Authorization", auth)
      .set("Idempotency-Key", key)
      .send({});
    expect(first.status).toBe(200);
    expect(attendance.checkIn).toHaveBeenCalledTimes(1);

    const retry = await request(app.getHttpServer())
      .post("/me/attendance/check-in")
      .set("Authorization", auth)
      .set("Idempotency-Key", key)
      .send({});
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(attendance.checkIn).toHaveBeenCalledTimes(1);

    const crossed = await request(app.getHttpServer())
      .post("/me/attendance/check-out")
      .set("Authorization", auth)
      .set("Idempotency-Key", key)
      .send({});
    expect(crossed.status).toBe(422);
    expect(attendance.checkOut).not.toHaveBeenCalled();
  });

  it("CROSS-TENANT: a second tenant's punch is written against its own org", async () => {
    const token = await signToken({
      orgId: "org_alien",
      sub: "user_alien",
      permissions: [SELF_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/me/attendance/check-in")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", CROSS_TENANT_IDEMPOTENCY_KEY)
      .send({});

    expect(res.status).toBe(200);
    const [orgId, userId] = attendance.checkIn.mock.calls[0] as unknown[];
    expect(orgId).toBe("org_alien");
    expect(userId).toBe("user_alien");
  });
});

describe("EmployeeAttendanceController — BITE PROOF (the self:attendance gate is load-bearing)", () => {
  let guarded: INestApplication;
  let ungated: INestApplication;
  const attendance = { status: jest.fn().mockResolvedValue({ status: "OFFLINE" }) };

  beforeAll(async () => {
    guarded = await createE2eApp({
      overrides: [{ provide: AttendanceService, useValue: attendance }],
    });
    ungated = await createE2eApp({
      overrides: [
        { provide: AttendanceService, useValue: attendance },
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
      .get("/me/attendance/status")
      .set("Authorization", `Bearer ${token}`);
    expect(denied.status).toBe(403);

    const allowed = await request(ungated.getHttpServer())
      .get("/me/attendance/status")
      .set("Authorization", `Bearer ${token}`);
    expect(allowed.status).toBe(200);
  });
});
