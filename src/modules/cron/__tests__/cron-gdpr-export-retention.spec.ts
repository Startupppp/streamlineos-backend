jest.mock("../../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    const holder = globalThis as { __gdprExportCronTx?: unknown };
    await fn(holder.__gdprExportCronTx, "org-test");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
  withTenant: async (
    _db: unknown,
    ctx: { orgId: string },
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    const holder = globalThis as {
      __gdprExportCronTx?: unknown;
      __gdprExportClearCalls?: Array<{ orgId: string }>;
    };
    holder.__gdprExportClearCalls = holder.__gdprExportClearCalls ?? [];
    holder.__gdprExportClearCalls.push({ orgId: ctx.orgId });
    return fn(holder.__gdprExportCronTx);
  },
}));

import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { StorageService } from "../../storage/storage.service";
import { CronGdprExportRetentionService } from "../cron-gdpr-export-retention.service";

// ─── The 72-hour expiry that never fired ─────────────────────────────────────
//
// MECHANISM: `GdprExportService` shipped `expireOldJobs` and `reclaim` and NOTHING in
// `src/` called either. So every subject-export archive — a complete JSON dump of one
// person's personal data — stayed `completed` and alive in object storage for ever, and
// a worker that died mid-run left its job wedged in `running` where `claim`, which only
// reads `pending`, could never pick it up again.
//
// The page fixtures below are deliberately LARGER than PAGE_SIZE (100). A fixture that
// fits in one page cannot tell a keyset drain from a silent cap, which is the exact
// defect this ticket has already shipped twice.

const PAGE_SIZE = 100;

interface ArtifactRow {
  id: string;
  fileKey: string | null;
}

interface TxRecorder {
  selectPages: ArtifactRow[][];
  selectCalls: number;
  expiredIds: string[][];
  clearedIds: string[][];
  reclaimRows: Array<{ id: string }>;
  auditPayloads: Array<Record<string, unknown>>;
}

function page(size: number, offset: number): ArtifactRow[] {
  return Array.from({ length: size }, (_, i) => ({
    id: `job-${String(offset + i).padStart(5, "0")}`,
    fileKey: `gdpr-exports/job-${String(offset + i).padStart(5, "0")}.json`,
  }));
}

function makeTx(options: {
  pages: ArtifactRow[][];
  reclaimRows?: Array<{ id: string }>;
}): TxRecorder {
  const rec: TxRecorder = {
    selectPages: options.pages,
    selectCalls: 0,
    expiredIds: [],
    clearedIds: [],
    reclaimRows: options.reclaimRows ?? [],
    auditPayloads: [],
  };

  const tx = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockImplementation(() => {
              const rows = rec.selectPages[rec.selectCalls] ?? [];
              rec.selectCalls += 1;
              return Promise.resolve(rows);
            }),
          }),
        }),
      }),
    })),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
        const isReclaim = patch["status"] === "pending";
        const isExpire = patch["status"] === "expired";
        const captured = { ids: [] as string[] };
        const where = jest.fn().mockImplementation(() => {
          const ret = {
            returning: jest.fn().mockImplementation(() => {
              if (isReclaim) return Promise.resolve(rec.reclaimRows);
              return Promise.resolve([]);
            }),
            then: undefined as unknown,
          };
          if (isExpire) rec.expiredIds.push(captured.ids);
          if (!isReclaim && !isExpire) rec.clearedIds.push(captured.ids);
          return Object.assign(Promise.resolve([]), ret);
        });
        return { where };
      }),
    })),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: { after: Record<string, unknown> }) => {
        rec.auditPayloads.push(row.after);
        return Promise.resolve(undefined);
      }),
    }),
  };

  (globalThis as { __gdprExportCronTx?: unknown }).__gdprExportCronTx = tx;
  return rec;
}

function makeStorage(failKeys: string[] = []) {
  return {
    deleteFileIfPresent: jest.fn(async (_orgId: string, key: string) => {
      if (failKeys.includes(key)) throw new Error("bucket refused the delete");
      return true;
    }),
  };
}

async function buildService(storage: {
  deleteFileIfPresent: jest.Mock;
}): Promise<CronGdprExportRetentionService> {
  const module = await Test.createTestingModule({
    providers: [
      CronGdprExportRetentionService,
      { provide: DRIZZLE, useValue: {} },
      { provide: StorageService, useValue: storage },
    ],
  }).compile();
  return module.get(CronGdprExportRetentionService);
}

beforeEach(() => {
  const holder = globalThis as { __gdprExportClearCalls?: unknown };
  holder.__gdprExportClearCalls = [];
  jest.clearAllMocks();
});

describe("CronGdprExportRetentionService — the artifact drain pages past the page size", () => {
  it("drains 2 full pages plus a tail and purges every artifact, not the first page", async () => {
    const rec = makeTx({
      pages: [page(PAGE_SIZE, 0), page(PAGE_SIZE, 100), page(37, 200)],
    });
    const storage = makeStorage();
    const service = await buildService(storage);

    const result = await service.sweep();

    expect(rec.selectCalls).toBe(3);
    expect(result.jobsExpired).toBe(237);
    expect(result.objectsDeleted).toBe(237);
    expect(result.objectsOrphaned).toBe(0);
    expect(result.truncated).toBe(false);
    expect(storage.deleteFileIfPresent).toHaveBeenCalledTimes(237);
  });

  it("(bite proof) a single short page yields one select and one page of deletes — the multi-page count is not an artefact", async () => {
    const rec = makeTx({ pages: [page(12, 0)] });
    const storage = makeStorage();
    const service = await buildService(storage);

    const result = await service.sweep();

    expect(rec.selectCalls).toBe(1);
    expect(result.jobsExpired).toBe(12);
    expect(storage.deleteFileIfPresent).toHaveBeenCalledTimes(12);
  });

  it("deletes the very last artifact of the tail page, so nothing past the first page is left behind", async () => {
    makeTx({ pages: [page(PAGE_SIZE, 0), page(5, 100)] });
    const storage = makeStorage();
    const service = await buildService(storage);

    await service.sweep();

    const keys = storage.deleteFileIfPresent.mock.calls.map((c) => c[1] as string);
    expect(keys).toContain("gdpr-exports/job-00104.json");
    expect(keys).toHaveLength(105);
  });
});

describe("CronGdprExportRetentionService — ordering: the object dies before the pointer to it", () => {
  it("clears file_key only for artifacts whose object delete succeeded", async () => {
    makeTx({ pages: [page(3, 0)] });
    const storage = makeStorage(["gdpr-exports/job-00001.json"]);
    const service = await buildService(storage);

    const result = await service.sweep();

    expect(result.objectsDeleted).toBe(2);
    expect(result.objectsOrphaned).toBe(1);
    const clears = (globalThis as { __gdprExportClearCalls?: unknown[] })
      .__gdprExportClearCalls;
    expect(clears).toHaveLength(1);
  });

  it("(bite proof) a sweep whose every delete fails clears no pointer at all, so the next tick retries", async () => {
    makeTx({ pages: [page(3, 0)] });
    const storage = makeStorage([
      "gdpr-exports/job-00000.json",
      "gdpr-exports/job-00001.json",
      "gdpr-exports/job-00002.json",
    ]);
    const service = await buildService(storage);

    const result = await service.sweep();

    expect(result.objectsDeleted).toBe(0);
    expect(result.objectsOrphaned).toBe(3);
    expect(
      (globalThis as { __gdprExportClearCalls?: unknown[] }).__gdprExportClearCalls,
    ).toHaveLength(0);
  });
});

describe("CronGdprExportRetentionService — a dead worker's job is reclaimed", () => {
  it("returns the jobs it moved out of running, so claim() can pick them up again", async () => {
    makeTx({ pages: [[]], reclaimRows: [{ id: "job-a" }, { id: "job-b" }] });
    const service = await buildService(makeStorage());

    const result = await service.sweep();

    expect(result.jobsReclaimed).toBe(2);
  });

  it("(bite proof) reports zero reclaimed when nothing is stale — the count is not a constant", async () => {
    makeTx({ pages: [[]] });
    const service = await buildService(makeStorage());

    const result = await service.sweep();

    expect(result.jobsReclaimed).toBe(0);
  });
});

describe("CronGdprExportRetentionService — the sweep is idempotent and audited", () => {
  it("a second sweep over an empty predicate expires nothing and deletes nothing", async () => {
    makeTx({ pages: [page(4, 0)] });
    const storage = makeStorage();
    const service = await buildService(storage);
    const first = await service.sweep();

    makeTx({ pages: [[]] });
    const second = await service.sweep();

    expect(first.jobsExpired).toBe(4);
    expect(second.jobsExpired).toBe(0);
    expect(second.objectsDeleted).toBe(0);
  });

  it("writes the count and the truncation flag into the durable audit payload, not just a log line", async () => {
    const rec = makeTx({ pages: [page(6, 0)] });
    const service = await buildService(makeStorage());

    await service.sweep();

    expect(rec.auditPayloads).toHaveLength(1);
    expect(rec.auditPayloads[0]).toMatchObject({ expired: 6, truncated: false });
  });

  it("does not write an audit row for an organisation with no eligible work", async () => {
    const rec = makeTx({ pages: [[]] });
    const service = await buildService(makeStorage());

    await service.sweep();

    expect(rec.auditPayloads).toHaveLength(0);
  });
});
