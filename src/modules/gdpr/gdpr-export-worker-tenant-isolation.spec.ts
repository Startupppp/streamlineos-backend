jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { drainExportPages, GdprExportWorkerService } from "./gdpr-export-worker.service";
import { GdprExportService } from "./gdpr-export.service";
import { StorageService } from "../storage/storage.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...((record as { params?: unknown[] }).params ? sqlValues((record as { params: unknown[] }).params, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeDb(): { db: Db; allWhereArgs: unknown[] } {
  const allWhereArgs: unknown[] = [];
  let selectCount = 0;
  const makeWhereResult = (rows: unknown[]) => {
    const limitFn = jest.fn().mockResolvedValue(rows);
    const orderByFn = jest.fn().mockReturnValue({ limit: limitFn });
    return {
      orderBy: orderByFn,
      limit: limitFn,
      then: (
        onFulfilled: (v: unknown[]) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    };
  };
  const db = {
    select: jest.fn().mockImplementation(() => {
      const rows = selectCount++ === 0
        ? [{ userId: "user-subj", email: "subject@example.invalid", name: null }]
        : [];
      return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockImplementation((arg: unknown) => {
          allWhereArgs.push(arg);
          return makeWhereResult(rows);
        }),
      }),
      };
    }),
  } as unknown as Db;
  return { db, allWhereArgs };
}

function makeServices(orgId: string) {
  const fakeJob = {
    id: 99,
    orgId,
    subjectUserId: "user-subj",
    createdAt: new Date("2026-01-01"),
  };
  const mockJobs = {
    claim: jest.fn().mockResolvedValue(fakeJob),
    complete: jest.fn().mockResolvedValue(undefined),
    fail: jest.fn().mockResolvedValue(undefined),
  };
  const mockStorage = {
    isConfigured: jest.fn().mockReturnValue(true),
    uploadFile: jest.fn().mockResolvedValue({ key: "k", size: 10 }),
  };
  return { mockJobs, mockStorage };
}

describe("GdprExportWorkerService — cross-tenant isolation", () => {
  const origEnv = process.env.GDPR_EXPORT_WORKER_ENABLED;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.GDPR_EXPORT_WORKER_ENABLED = "false";
  });

  afterEach(() => {
    process.env.GDPR_EXPORT_WORKER_ENABLED = origEnv;
  });

  it("scopes every fetch WHERE to the attacker org only (cross-tenant isolation)", async () => {
    const { db, allWhereArgs } = makeDb();
    const { mockJobs, mockStorage } = makeServices(ATTACKER_ORG);

    (forEachOrg as jest.Mock).mockImplementation(
      async (
        _db: unknown,
        _label: unknown,
        cb: (tx: unknown, orgId: string) => Promise<void>,
      ) => {
        await cb(undefined, ATTACKER_ORG);
      },
    );

    const module = await Test.createTestingModule({
      providers: [
        GdprExportWorkerService,
        { provide: DRIZZLE, useValue: db },
        { provide: GdprExportService, useValue: mockJobs },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    const svc = module.get(GdprExportWorkerService);

    svc.wake();
    await flushPromises();

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap((w) => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
    expect(allVals).not.toContain(OWNER_ORG);
  });

  it("scopes every fetch WHERE to the owner org only (same-tenant control — proves bite)", async () => {
    const { db, allWhereArgs } = makeDb();
    const { mockJobs, mockStorage } = makeServices(OWNER_ORG);

    (forEachOrg as jest.Mock).mockImplementation(
      async (
        _db: unknown,
        _label: unknown,
        cb: (tx: unknown, orgId: string) => Promise<void>,
      ) => {
        await cb(undefined, OWNER_ORG);
      },
    );

    const module = await Test.createTestingModule({
      providers: [
        GdprExportWorkerService,
        { provide: DRIZZLE, useValue: db },
        { provide: GdprExportService, useValue: mockJobs },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    const svc = module.get(GdprExportWorkerService);

    svc.wake();
    await flushPromises();

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap((w) => sqlValues(w));
    expect(allVals).toContain(OWNER_ORG);
    expect(allVals).not.toContain(ATTACKER_ORG);
  });
});

describe("drainExportPages", () => {
  it("resumes after the batch boundary and never truncates an available section", async () => {
    const first = Array.from({ length: 200 }, (_, index) => ({ id: index + 1 }));
    const second = Array.from({ length: 4_801 }, (_, index) => ({ id: index + 201 }));
    const calls: Array<number | undefined> = [];
    const result = await drainExportPages(async (afterId) => {
      calls.push(afterId);
      if (afterId === undefined) return first;
      if (afterId === 200) return second;
      return [];
    });

    expect(result.rows).toHaveLength(5_001);
    expect(result.truncated).toBe(false);
    expect(calls).toEqual([undefined, 200, 5_001]);
  });
});
