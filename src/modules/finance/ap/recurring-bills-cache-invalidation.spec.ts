import type { Db } from "../../../db/drizzle.module";
import { RecurringBillsService } from "./recurring-bills.service";

const ORG_ID = "org-rb-test";
const USER_ID = "user-rb";
const TPL_ID = 42;

const MOCK_TEMPLATE = {
  id: TPL_ID,
  orgId: ORG_ID,
  name: "Monthly Rent",
  vendorId: 1,
  frequency: "MONTHLY",
  nextRunDate: "2024-02-01",
  endDate: null,
  isActive: true,
  payload: {},
  createdBy: USER_ID,
  updatedAt: new Date(),
};

function buildDb() {
  const returning = jest.fn().mockResolvedValue([MOCK_TEMPLATE]);
  const whereAfterSet = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where: whereAfterSet });
  const whereDelete = jest.fn().mockResolvedValue([]);
  const selectRows = jest.fn().mockResolvedValue([MOCK_TEMPLATE]);

  return {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([MOCK_TEMPLATE]) }),
    }),
    update: jest.fn().mockReturnValue({ set }),
    delete: jest.fn().mockReturnValue({ where: whereDelete }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: selectRows }),
      }),
    }),
  } as unknown as Db;
}

function buildService(db: Db, cache: { invalidate: jest.Mock }) {
  const audit = { log: jest.fn() };
  const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
  return new RecurringBillsService(db, audit as never, cache as never, dispatch as never);
}

function orderedCache(order) {
  const invalidate = jest.fn().mockImplementation(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    order.push("invalidate");
  });
  return { invalidate };
}

describe("RecurringBillsService — cache.invalidate is not fire-and-forget", () => {
  it("createTemplate resolves only after invalidation completes for the org-scoped recurring-cache key", async () => {
    const order: string[] = [];
    const cache = orderedCache(order);
    const db = buildDb();
    const svc = buildService(db, cache);

    await svc.createTemplate(ORG_ID, USER_ID, {
      name: "Monthly Rent",
      frequency: "MONTHLY",
      isActive: true,
      payload: {} as never,
    });

    order.push("method");
    expect(order).toEqual(["invalidate", "method"]);
    expect(String(cache.invalidate.mock.calls[0]?.[0])).toContain(ORG_ID);
  });

  it("updateTemplate resolves only after invalidation completes for the org-scoped recurring-cache key", async () => {
    const order: string[] = [];
    const cache = orderedCache(order);
    const db = buildDb();
    const svc = buildService(db, cache);

    await svc.updateTemplate(ORG_ID, USER_ID, TPL_ID, { name: "Updated Rent" });

    order.push("method");
    expect(order).toEqual(["invalidate", "method"]);
    expect(String(cache.invalidate.mock.calls[0]?.[0])).toContain(ORG_ID);
  });

  it("deleteTemplate resolves only after invalidation completes for the org-scoped recurring-cache key", async () => {
    const order: string[] = [];
    const cache = orderedCache(order);
    const db = buildDb();
    const svc = buildService(db, cache);

    await svc.deleteTemplate(ORG_ID, USER_ID, TPL_ID);

    order.push("method");
    expect(order).toEqual(["invalidate", "method"]);
    expect(String(cache.invalidate.mock.calls[0]?.[0])).toContain(ORG_ID);
  });
});
