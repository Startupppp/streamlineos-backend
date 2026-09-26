import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { KbIndexedBytesQuotaService, KB_DEFAULT_LIMIT_BYTES } from "./kb-indexed-bytes-quota.service";
import { KbIndexedBytesQuotaExceededException } from "../../../common/http/api-exceptions";

function makeUpdateChain(rows: { indexedBytes: number; limitBytes: number }[]) {
  const returning = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  return jest.fn().mockReturnValue({ set });
}

function makeInsertChain(onConflictFn = jest.fn().mockResolvedValue([])) {
  const onConflictDoNothing = onConflictFn;
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  return jest.fn().mockReturnValue({ values });
}

function makeSelectChain(rows: { limitBytes: number }[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  return jest.fn().mockReturnValue({ from });
}

function makeTx(opts: {
  updateRows?: { indexedBytes: number; limitBytes: number }[];
  limitRows?: { limitBytes: number }[];
  onConflictFn?: jest.Mock;
} = {}): TenantTx {
  const updateRows = opts.updateRows ?? [{ indexedBytes: 100, limitBytes: KB_DEFAULT_LIMIT_BYTES }];
  const limitRows = opts.limitRows ?? [{ limitBytes: KB_DEFAULT_LIMIT_BYTES }];

  return {
    insert: makeInsertChain(opts.onConflictFn),
    update: makeUpdateChain(updateRows),
    select: makeSelectChain(limitRows),
  } as unknown as TenantTx;
}

function makeDbForRelease(rows: unknown[] = []) {
  const where = jest.fn().mockResolvedValue(rows);
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return { update } as unknown as Db;
}

describe("KbIndexedBytesQuotaService.reserve — under-cap", () => {
  it("resolves without throwing when bytes fit within the limit (under-cap accepted)", async () => {
    const tx = makeTx();
    const svc = new KbIndexedBytesQuotaService({} as unknown as Db);

    await expect(svc.reserve(tx, "org-1", 1024)).resolves.toBeUndefined();
  });

  it("is a no-op when bytes is zero (no DB call, skips quota check)", async () => {
    const insertSpy = makeInsertChain();
    const tx = { insert: insertSpy, update: makeUpdateChain([]), select: makeSelectChain([]) } as unknown as TenantTx;
    const svc = new KbIndexedBytesQuotaService({} as unknown as Db);

    await svc.reserve(tx, "org-1", 0);

    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("KbIndexedBytesQuotaService.reserve — over-cap refused with 402 naming the limit", () => {
  it("throws KbIndexedBytesQuotaExceededException when the UPDATE WHERE condition fails (capacity full)", async () => {
    const limit = 512;
    const tx = makeTx({ updateRows: [], limitRows: [{ limitBytes: limit }] });
    const svc = new KbIndexedBytesQuotaService({} as unknown as Db);

    await expect(svc.reserve(tx, "org-1", 100)).rejects.toBeInstanceOf(
      KbIndexedBytesQuotaExceededException,
    );
  });

  it("names the limit in the 402 message and details (message includes limitBytes)", async () => {
    const limit = 512;
    const tx = makeTx({ updateRows: [], limitRows: [{ limitBytes: limit }] });
    const svc = new KbIndexedBytesQuotaService({} as unknown as Db);

    let caught: unknown;
    try {
      await svc.reserve(tx, "org-1", 100);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(KbIndexedBytesQuotaExceededException);
    if (caught instanceof KbIndexedBytesQuotaExceededException) {
      const body = caught.getResponse() as Record<string, unknown>;
      expect(body.details).toMatchObject({ limitBytes: limit });
      expect(String(body.message)).toContain(String(limit));
    }
  });
});

describe("KbIndexedBytesQuotaService.reserve — missing quota row initialised on first write", () => {
  it("calls values then onConflictDoNothing before the UPDATE so a first-write inserts zero bytes", async () => {
    const onConflictSpy = jest.fn().mockResolvedValue([]);
    const tx = makeTx({ onConflictFn: onConflictSpy });
    const svc = new KbIndexedBytesQuotaService({} as unknown as Db);

    await svc.reserve(tx, "org-new", 100);

    expect(onConflictSpy).toHaveBeenCalledTimes(1);
  });

  it("succeeds even when no quota row existed before (first-write control)", async () => {
    const tx = makeTx();
    const svc = new KbIndexedBytesQuotaService({} as unknown as Db);

    await expect(svc.reserve(tx, "org-new", 100)).resolves.toBeUndefined();
  });
});

describe("KbIndexedBytesQuotaService.reserve — concurrent reservations cannot both pass the cap", () => {
  it("throws 402 when the atomic UPDATE WHERE rejects the increment (simulates losing the race to a concurrent request)", async () => {
    const limit = 512;
    const tx = makeTx({ updateRows: [], limitRows: [{ limitBytes: limit }] });
    const svc = new KbIndexedBytesQuotaService({} as unknown as Db);

    await expect(svc.reserve(tx, "org-1", 100)).rejects.toBeInstanceOf(
      KbIndexedBytesQuotaExceededException,
    );
  });

  it("resolves when the atomic UPDATE WHERE accepts the increment (wins the race)", async () => {
    const tx = makeTx({ updateRows: [{ indexedBytes: 100, limitBytes: 512 }] });
    const svc = new KbIndexedBytesQuotaService({} as unknown as Db);

    await expect(svc.reserve(tx, "org-1", 100)).resolves.toBeUndefined();
  });
});

describe("KbIndexedBytesQuotaService.release — release on indexing failure", () => {
  it("calls db.update to decrement indexed_bytes when bytes > 0 (bytes released after failure)", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const set = jest.fn().mockReturnValue({ where });
    const updateSpy = jest.fn().mockReturnValue({ set });
    const db = { update: updateSpy } as unknown as Db;
    const svc = new KbIndexedBytesQuotaService(db);

    await svc.release("org-1", 1024);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("skips the update when bytes is zero (no-op avoids spurious DB writes)", async () => {
    const updateSpy = jest.fn();
    const db = { update: updateSpy } as unknown as Db;
    const svc = new KbIndexedBytesQuotaService(db);

    await svc.release("org-1", 0);

    expect(updateSpy).not.toHaveBeenCalled();
  });
});
