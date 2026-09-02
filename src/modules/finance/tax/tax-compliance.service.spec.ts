import fs from "fs";
import path from "path";
import { TaxComplianceService } from "./tax-compliance.service";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

const SERVICE_SRC = path.join(__dirname, "tax-compliance.service.ts");

type ServicePrivate = {
  getAllActiveOrgIds: () => Promise<string[]>;
  computeNetLiability: (orgId: string) => Promise<number>;
  daysBetween: (from: string, to: string) => number;
};

function makeOrgListDb(orgIds: string[]): Db {
  const rows = orgIds.map((id) => ({ id }));
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn().mockResolvedValue(rows),
    limit: jest.fn().mockResolvedValue(rows.slice(0, 500)),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
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

function makeSvc(db: Db, cache: object, dispatch: object): TaxComplianceService {
  return new TaxComplianceService(
    db,
    cache as CacheService,
    dispatch as NotificationDispatchService,
  );
}

function stubDateWindow(svc: TaxComplianceService): void {
  jest.spyOn(svc as unknown as ServicePrivate, "daysBetween").mockReturnValue(3);
}

describe("TaxComplianceService — org enumeration (DEFECT A)", () => {
  it("does not have a fixed .limit(500) cap on the org query", () => {
    const src = fs.readFileSync(SERVICE_SRC, "utf8");
    expect(src).not.toMatch(/\.limit\(500\)/);
  });

  it("filters by ACTIVE status and null deletedAt and sorts by id", () => {
    const src = fs.readFileSync(SERVICE_SRC, "utf8");
    expect(src).toContain('"ACTIVE"');
    expect(src).toContain("isNull");
    expect(src).toContain("asc(organizations.id)");
  });

  it("dispatches for every org when the list exceeds 500", async () => {
    const orgIds = Array.from({ length: 501 }, (_, i) => `org-${String(i).padStart(3, "0")}`);
    const db = makeOrgListDb(orgIds);
    const cache = makeCache("PENDING");
    const dispatch = makeDispatch();
    const svc = makeSvc(db, cache, dispatch);
    stubDateWindow(svc);
    jest.spyOn(svc as unknown as ServicePrivate, "computeNetLiability").mockResolvedValue(1000);

    await svc.checkTaxDue();

    expect(dispatch.emit).toHaveBeenCalledTimes(501);
  });
});

describe("TaxComplianceService — dedup guard (DEFECT B)", () => {
  it("skips dispatch when cache shows notification was already SENT", async () => {
    const cache = makeCache("SENT");
    const dispatch = makeDispatch();
    const svc = makeSvc({} as Db, cache, dispatch);
    stubDateWindow(svc);
    jest.spyOn(svc as unknown as ServicePrivate, "getAllActiveOrgIds").mockResolvedValue(["org-x"]);
    jest.spyOn(svc as unknown as ServicePrivate, "computeNetLiability").mockResolvedValue(500);

    await svc.checkTaxDue();

    expect(dispatch.emit).not.toHaveBeenCalled();
  });

  it("dispatches on the first sweep and writes SENT into the cache", async () => {
    const cache = makeCache("PENDING");
    const dispatch = makeDispatch();
    const svc = makeSvc({} as Db, cache, dispatch);
    stubDateWindow(svc);
    jest.spyOn(svc as unknown as ServicePrivate, "getAllActiveOrgIds").mockResolvedValue(["org-y"]);
    jest.spyOn(svc as unknown as ServicePrivate, "computeNetLiability").mockResolvedValue(500);

    await svc.checkTaxDue();

    expect(dispatch.emit).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining("org-y"),
      "SENT",
      expect.any(Number),
    );
  });

  it("dedup key encodes the org id and the gstr1 due date", async () => {
    const cache = makeCache("PENDING");
    const dispatch = makeDispatch();
    const svc = makeSvc({} as Db, cache, dispatch);
    stubDateWindow(svc);
    jest.spyOn(svc as unknown as ServicePrivate, "getAllActiveOrgIds").mockResolvedValue(["org-dedup"]);
    jest.spyOn(svc as unknown as ServicePrivate, "computeNetLiability").mockResolvedValue(500);

    await svc.checkTaxDue();

    const keyArg: string = (cache.set as jest.Mock).mock.calls[0]?.[0] as string;
    expect(keyArg).toContain("org-dedup");
    expect(keyArg).toMatch(/\d{4}-\d{2}-11/);
  });
});

describe("TaxComplianceService — cache fail-closed (DEFECT C behaviour)", () => {
  it("skips dispatch when the dedup cache read throws (fail closed)", async () => {
    const cache = makeCache("PENDING", true);
    const dispatch = makeDispatch();
    const svc = makeSvc({} as Db, cache, dispatch);
    stubDateWindow(svc);
    jest.spyOn(svc as unknown as ServicePrivate, "getAllActiveOrgIds").mockResolvedValue(["org-z"]);
    jest.spyOn(svc as unknown as ServicePrivate, "computeNetLiability").mockResolvedValue(500);

    await svc.checkTaxDue();

    expect(dispatch.emit).not.toHaveBeenCalled();
  });
});
