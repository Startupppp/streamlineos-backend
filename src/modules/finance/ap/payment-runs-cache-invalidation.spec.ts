import type { Db } from "../../../db/drizzle.module";

jest.mock("../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn().mockResolvedValue({ membershipId: "mem-1", userId: "user-1" }),
}));

import { PaymentRunsService } from "./payment-runs.service";

const ORG_ID = "org-pr-test";
const USER_ID = "user-1";
const RUN_ID = 1;

const MOCK_RUN = {
  id: RUN_ID,
  orgId: ORG_ID,
  name: "Test Run",
  status: "DRAFT",
  totalAmount: "1000.00",
  approvedBy: null,
  approvedAt: null,
};

function thenable(rows: unknown[]) {
  const p = Promise.resolve(rows) as Promise<unknown[]> & { limit: jest.Mock; returning: jest.Mock };
  p.limit = jest.fn().mockResolvedValue(rows);
  p.returning = jest.fn().mockResolvedValue(rows);
  return p;
}

function buildDb(run: object): Db {
  const noApprovalPolicies = thenable([]);
  const runRows = thenable([run]);

  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => runRows),
        limit: jest.fn().mockResolvedValue([run]),
      })),
    })),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue(thenable([run])),
      }),
    }),
    count: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ count: 0 }]) }),
    }),
    _: noApprovalPolicies,
  } as unknown as Db;
}

function buildService(db: Db, cache: { invalidate: jest.Mock }) {
  const audit = { log: jest.fn() };
  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
  return new PaymentRunsService(db, audit as never, cache as never, dispatch as never);
}

function orderedCache(order: string[]) {
  const invalidate = jest.fn().mockImplementation(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    order.push("invalidate");
  });
  return { invalidate };
}

describe("PaymentRunsService — cache.invalidate is awaited (not fire-and-forget)", () => {
  it("approveRun resolves only after the org-scoped invalidation has completed", async () => {
    const order: string[] = [];
    const cache = orderedCache(order);
    const svc = buildService(buildDb(MOCK_RUN), cache);

    const u = { userId: USER_ID, orgId: ORG_ID, role: "ADMIN", isOrgOwner: false, sessionId: "s1", tokenScopes: null, principal: null };
    await svc.approveRun(u as never, RUN_ID);
    order.push("method");

    expect(order).toEqual(["invalidate", "method"]);
    expect(String(cache.invalidate.mock.calls[0]?.[0])).toContain(ORG_ID);
  });

  it("cancelRun resolves only after the org-scoped invalidation has completed", async () => {
    const order: string[] = [];
    const cache = orderedCache(order);
    const svc = buildService(buildDb(MOCK_RUN), cache);

    await svc.cancelRun(ORG_ID, USER_ID, RUN_ID);
    order.push("method");

    expect(order).toEqual(["invalidate", "method"]);
    expect(String(cache.invalidate.mock.calls[0]?.[0])).toContain(ORG_ID);
  });
});
