import { BillsDueCheckService } from "./bills-due-check.service";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

interface BillRow {
  id: number;
  orgId: string;
  billNumber: string;
  dueDate: string;
  total: string;
  amountPaid: string;
  vendorId: number;
  createdBy: string;
  vendorName: string | null;
}

function makeBill(overrides: Partial<BillRow> = {}): BillRow {
  return {
    id: 1,
    orgId: "org-bills",
    billNumber: "BILL-001",
    dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    total: "10000",
    amountPaid: "0",
    vendorId: 42,
    createdBy: "user-abc",
    vendorName: "ACME Corp",
    ...overrides,
  };
}

function makeDb(bills: BillRow[] = []): Db {
  const chain = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn().mockResolvedValue(bills),
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  return { select: jest.fn().mockReturnValue(chain) } as unknown as Db;
}

function makeCache(storedValue = "PENDING", throws = false): jest.Mocked<Pick<CacheService, "cached" | "set">> {
  return {
    cached: throws
      ? jest.fn().mockRejectedValue(new Error("Redis unavailable"))
      : jest.fn().mockResolvedValue(storedValue),
    set: jest.fn().mockResolvedValue(undefined),
  };
}

function makeDispatch(): jest.Mocked<Pick<NotificationDispatchService, "emit">> {
  return { emit: jest.fn().mockResolvedValue(undefined) };
}

function makeSvc(db: Db, cache: object, dispatch: object): BillsDueCheckService {
  return new BillsDueCheckService(
    db,
    cache as CacheService,
    dispatch as NotificationDispatchService,
  );
}

describe("BillsDueCheckService — dedup (DEFECT B / bills)", () => {
  it("does not dispatch when cache shows the bill was already notified (SENT)", async () => {
    const db = makeDb([makeBill()]);
    const cache = makeCache("SENT");
    const dispatch = makeDispatch();
    const svc = makeSvc(db, cache, dispatch);

    await svc.checkBillsDue("org-bills");

    expect(dispatch.emit).not.toHaveBeenCalled();
  });

  it("dispatches and writes SENT into cache on first sweep", async () => {
    const db = makeDb([makeBill()]);
    const cache = makeCache("PENDING");
    const dispatch = makeDispatch();
    const svc = makeSvc(db, cache, dispatch);

    await svc.checkBillsDue("org-bills");

    expect(dispatch.emit).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining("org-bills"),
      "SENT",
      expect.any(Number),
    );
  });
});

describe("BillsDueCheckService — cache fail-closed (DEFECT C)", () => {
  it("does not dispatch when the dedup cache read throws", async () => {
    const db = makeDb([makeBill()]);
    const cache = makeCache("PENDING", true);
    const dispatch = makeDispatch();
    const svc = makeSvc(db, cache, dispatch);

    await svc.checkBillsDue("org-bills");

    expect(dispatch.emit).not.toHaveBeenCalled();
  });

  it("does not dispatch for any bill when cache throws, even with multiple qualifying bills", async () => {
    const bills = [makeBill({ id: 1 }), makeBill({ id: 2 }), makeBill({ id: 3 })];
    const db = makeDb(bills);
    const cache = makeCache("PENDING", true);
    const dispatch = makeDispatch();
    const svc = makeSvc(db, cache, dispatch);

    await svc.checkBillsDue("org-bills");

    expect(dispatch.emit).not.toHaveBeenCalled();
  });
});
