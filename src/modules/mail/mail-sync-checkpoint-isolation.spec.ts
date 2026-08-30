jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

import type { Db } from "../../db/drizzle.module";
import { MailSyncCheckpointService } from "./mail-sync-checkpoint.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

beforeEach(() => jest.resetAllMocks());

describe("MailSyncCheckpointService.loadPosition — tenant isolation", () => {
  function makeDb(row: unknown) {
    let capturedWhere: unknown;
    const limit = jest.fn().mockResolvedValue(row ? [row] : []);
    const where = jest.fn().mockImplementation((pred: unknown) => {
      capturedWhere = pred;
      return { limit };
    });
    const from = jest.fn().mockReturnValue({ where });
    const db = {
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
    return { db, getWhere: () => capturedWhere };
  }

  it("DENY: loadPosition binds predicate to ATTACKER org and returns null (no row)", async () => {
    const { db, getWhere } = makeDb(null);
    const service = new MailSyncCheckpointService(db);

    const result = await service.loadPosition(ATTACKER, 1, "INBOX");

    expect(sqlValues(getWhere())).toContain(ATTACKER);
    expect(sqlValues(getWhere())).not.toContain(OWNER);
    expect(result).toBeNull();
  });

  it("CONTROL: loadPosition binds predicate to OWNER org and returns the cursor", async () => {
    const { db, getWhere } = makeDb({ cursorValue: "token-xyz" });
    const service = new MailSyncCheckpointService(db);

    const result = await service.loadPosition(OWNER, 1, "INBOX");

    expect(sqlValues(getWhere())).toContain(OWNER);
    expect(result).toBe("token-xyz");
  });
});

describe("MailSyncCheckpointService.savePosition — tenant isolation", () => {
  function makeDb() {
    const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;
    return { db, insert, values, onConflictDoUpdate };
  }

  it("DENY: savePosition writes into the tx scoped to ATTACKER org", async () => {
    const { db, values } = makeDb();
    const service = new MailSyncCheckpointService(db);

    await service.savePosition(ATTACKER, 1, "INBOX", "cursor-1");

    const [payload] = values.mock.calls[0] as [{ orgId: string }];
    expect(payload.orgId).toBe(ATTACKER);
  });

  it("CONTROL: savePosition writes into the tx scoped to OWNER org and returns", async () => {
    const { db, values } = makeDb();
    const service = new MailSyncCheckpointService(db);

    await service.savePosition(OWNER, 2, "SENT", "cursor-2");

    const [payload] = values.mock.calls[0] as [{ orgId: string; accountId: number; folder: string; cursorValue: string }];
    expect(payload.orgId).toBe(OWNER);
    expect(payload.accountId).toBe(2);
    expect(payload.folder).toBe("SENT");
    expect(payload.cursorValue).toBe("cursor-2");
  });
});
