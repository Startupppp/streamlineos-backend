jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp, accessStub } from "test/helpers/e2e-app";
import { ALL_MODULES, signToken } from "test/helpers/sign-token";
import { AccessService } from "src/modules/access/access.service";
import { ExpensesService } from "src/modules/expenses/expenses.service";
import { ExpensesWriteService } from "src/modules/expenses/expenses-write.service";
import { SELF_ONLY_SCOPE } from "src/modules/expenses/expenses-scope";

/**
 * PRD-C115 — representative E2E for `/me/expenses`.
 *
 * The Home E2E this ticket inherited asserted 401 over eighteen dashboard
 * routes and nothing else, and all three self-service controllers — twenty
 * routes — had no controller spec of any kind. "Representative" means every
 * tier the request actually passes through: unauthenticated, authenticated but
 * unpermitted, permitted, and — the one that matters on a money surface — the
 * subject the handler resolves.
 *
 * Every route here derives its subject from `@CurrentUser()`. The client never
 * gets to name one. These cases prove it by handing the endpoint a `userId` for
 * somebody else and asserting the service is still called for the caller.
 */

const SELF = "user_1";
const VICTIM = "user_victim";
const SELF_PERMISSION = "self:expenses";

const PAGE_DATA = {
  expenses: [],
  pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 },
  stats: null,
  isAdmin: false,
};

const CREATE_BODY = {
  category: "Meals",
  amount: 2400,
  expenseDate: "2026-09-01",
  merchant: "Bistro",
};

describe("EmployeeExpensesController — /me/expenses (e2e)", () => {
  let app: INestApplication;
  const getPageData = jest.fn().mockResolvedValue(PAGE_DATA);
  const create = jest.fn().mockResolvedValue({ id: 7 });
  const updateOwn = jest.fn().mockResolvedValue({ id: 7 });

  beforeAll(async () => {
    app = await createE2eApp({
      overrides: [
        { provide: ExpensesService, useValue: { getPageData } },
        { provide: ExpensesWriteService, useValue: { create, updateOwn } },
      ],
    });
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    getPageData.mockClear();
    create.mockClear();
    updateOwn.mockClear();
  });

  const routes: ReadonlyArray<[method: "get" | "post" | "patch", path: string]> = [
    ["get", "/me/expenses"],
    ["post", "/me/expenses"],
    ["patch", "/me/expenses/7"],
  ];

  function call(method: "get" | "post" | "patch", path: string): request.Test {
    const agent = request(app.getHttpServer());
    if (method === "get") return agent.get(path);
    if (method === "post") return agent.post(path);
    return agent.patch(path);
  }

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED" });
    expect(getPageData).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(updateOwn).not.toHaveBeenCalled();
  });

  it.each(routes)(
    "403 on %s %s for a member who does not hold self:expenses",
    async (method, path) => {
      const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });
      const res = await call(method, path)
        .set("Authorization", `Bearer ${token}`)
        .send(method === "get" ? undefined : CREATE_BODY);
      expect(res.status).toBe(403);
      expect(getPageData).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(updateOwn).not.toHaveBeenCalled();
    },
  );

  it("200 on GET, and the read is scoped to the caller alone", async () => {
    const token = await signToken({
      permissions: [SELF_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/me/expenses?page=1&pageSize=10")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(getPageData).toHaveBeenCalledTimes(1);
    const [orgId, userId, scope] = getPageData.mock.calls[0] as unknown[];
    expect(orgId).toBe("org_1");
    expect(userId).toBe(SELF);
    expect(scope).toEqual(SELF_ONLY_SCOPE);
  });

  it("PRIVACY: a client-supplied userId cannot widen the read to another member", async () => {
    const token = await signToken({
      permissions: [SELF_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get(`/me/expenses?page=1&pageSize=10&userId=${VICTIM}`)
      .set("Authorization", `Bearer ${token}`);

    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      const [orgId, userId, scope, filters] = getPageData.mock
        .calls[0] as unknown[];
      expect(orgId).toBe("org_1");
      expect(userId).toBe(SELF);
      expect(scope).toEqual(SELF_ONLY_SCOPE);
      expect(JSON.stringify(filters)).not.toContain(VICTIM);
    }
  });

  it("201 on POST, and the claim is filed against the caller, never a supplied author", async () => {
    const token = await signToken({
      permissions: [SELF_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .post("/me/expenses")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...CREATE_BODY });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    const [orgId, userId, body] = create.mock.calls[0] as unknown[];
    expect(orgId).toBe("org_1");
    expect(userId).toBe(SELF);
    expect(JSON.stringify(body)).not.toContain(VICTIM);
  });

  it("PATCH updates only the caller's own claim", async () => {
    const token = await signToken({
      permissions: [SELF_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .patch("/me/expenses/7")
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: 100 });

    expect(res.status).toBe(200);
    expect(updateOwn).toHaveBeenCalledTimes(1);
    const [orgId, userId, expenseId] = updateOwn.mock.calls[0] as unknown[];
    expect(orgId).toBe("org_1");
    expect(userId).toBe(SELF);
    expect(expenseId).toBe(7);
  });

  it("CROSS-TENANT: the org comes from the token, so a second tenant reads its own rows", async () => {
    const token = await signToken({
      orgId: "org_alien",
      sub: "user_alien",
      permissions: [SELF_PERMISSION],
      enabledModules: ALL_MODULES,
    });
    const res = await request(app.getHttpServer())
      .get("/me/expenses?page=1&pageSize=10")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(getPageData).toHaveBeenCalledWith(
      "org_alien",
      "user_alien",
      SELF_ONLY_SCOPE,
      expect.any(Object),
    );
    expect(getPageData).not.toHaveBeenCalledWith(
      "org_1",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("EmployeeExpensesController — BITE PROOF (the self:expenses gate is load-bearing)", () => {
  let guarded: INestApplication;
  let ungated: INestApplication;
  const getPageData = jest.fn().mockResolvedValue(PAGE_DATA);

  beforeAll(async () => {
    guarded = await createE2eApp({
      overrides: [{ provide: ExpensesService, useValue: { getPageData } }],
    });
    ungated = await createE2eApp({
      overrides: [
        { provide: ExpensesService, useValue: { getPageData } },
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

  it("neutering PermissionGuard turns the same 403 request into a 200 — the deny assertions are not vacuous", async () => {
    const token = await signToken({ permissions: [], enabledModules: ALL_MODULES });

    const denied = await request(guarded.getHttpServer())
      .get("/me/expenses?page=1&pageSize=10")
      .set("Authorization", `Bearer ${token}`);
    expect(denied.status).toBe(403);

    const allowed = await request(ungated.getHttpServer())
      .get("/me/expenses?page=1&pageSize=10")
      .set("Authorization", `Bearer ${token}`);
    expect(allowed.status).toBe(200);
  });
});
