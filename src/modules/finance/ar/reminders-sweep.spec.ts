import { RemindersService } from "./reminders.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function makeSelectChain(rows: unknown[] = []): Record<string, jest.Mock> {
  const chain: Record<string, jest.Mock> = {};
  for (const m of ["from", "where", "orderBy"]) chain[m] = jest.fn().mockReturnValue(chain);
  chain["limit"] = jest.fn().mockResolvedValue(rows);
  return chain;
}

function makeTxMock() {
  const returning = jest.fn().mockResolvedValue([]);
  const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate, then: undefined });
  const insert = jest.fn().mockReturnValue({ values });
  return { insert };
}

function makeDb(candidates: unknown[] = []): Db & { execute: jest.Mock; transaction: jest.Mock; select: jest.Mock } {
  const tx = makeTxMock();
  return {
    execute: jest.fn().mockResolvedValue(candidates),
    select: jest.fn().mockReturnValue(makeSelectChain([])),
    transaction: jest.fn().mockImplementation(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    query: { finReminderPolicies: { findFirst: jest.fn() } },
  } as unknown as Db & { execute: jest.Mock; transaction: jest.Mock; select: jest.Mock };
}

const audit = { log: jest.fn() } as unknown as AuditService;

describe("RemindersService.sweepOrg — single candidate query replaces nested policy×invoice×offset loops", () => {
  it("issues exactly one db.execute for all candidates — not one per policy or invoice page", async () => {
    const db = makeDb([]);
    const svc = new RemindersService(db, audit);
    await svc.processDueReminders("org-solo");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("the single execute query carries the org id as a bound parameter", async () => {
    const db = makeDb([]);
    const svc = new RemindersService(db, audit);
    await svc.processDueReminders("org-abc123");
    const queryArg = (db.execute as jest.Mock).mock.calls[0]?.[0];
    expect(sqlValues(queryArg)).toContain("org-abc123");
  });

  it("does not open a transaction when the candidate query returns no rows", async () => {
    const db = makeDb([]);
    const svc = new RemindersService(db, audit);
    await svc.processDueReminders("org-empty");
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("opens exactly one transaction regardless of how many candidates the query returns", async () => {
    const candidates = [
      { invoice_id: 1, invoice_number: "INV-001", collection_owner_id: null, channel: "EMAIL", offset_days: 3 },
      { invoice_id: 2, invoice_number: "INV-002", collection_owner_id: null, channel: "EMAIL", offset_days: 3 },
      { invoice_id: 3, invoice_number: "INV-003", collection_owner_id: null, channel: "WHATSAPP", offset_days: -7 },
    ];
    const db = makeDb(candidates);
    const svc = new RemindersService(db, audit);
    await svc.processDueReminders("org-multi");
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("RemindersService.sweepOrg — per-org isolation", () => {
  it("each org's candidate query carries only that org's id, never another org's", async () => {
    const db = makeDb([]);
    const svc = new RemindersService(db, audit);

    await svc.processDueReminders("org-alpha");
    await svc.processDueReminders("org-beta");

    const calls = (db.execute as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);

    const valuesForAlpha = sqlValues(calls[0]?.[0]);
    const valuesForBeta = sqlValues(calls[1]?.[0]);

    expect(valuesForAlpha).toContain("org-alpha");
    expect(valuesForBeta).toContain("org-beta");
    expect(valuesForAlpha).not.toContain("org-beta");
    expect(valuesForBeta).not.toContain("org-alpha");
  });

  it("processDueReminders without orgId delegates to forEachOrg (source evidence)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "reminders.service.ts"), "utf8");
    expect(src).toContain("forEachOrg");
    expect(src).toContain("finance:invoice-reminders");
  });
});

describe("RemindersService retention — fin_reminder_log is never physically deleted", () => {
  it("the service source contains no hard DELETE on fin_reminder_log", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "reminders.service.ts"), "utf8");
    const hasDelete = /\bthis\.db\.delete\b/.test(src) || /\btx\.delete\b/.test(src);
    expect(hasDelete).toBe(false);
  });

  it("deletePolicy soft-archives via archivedAt, not a hard delete", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "reminders.service.ts"), "utf8");
    const deletePolicyIdx = src.indexOf("async deletePolicy");
    const archivedAtIdx = src.indexOf("archivedAt", deletePolicyIdx);
    expect(deletePolicyIdx).toBeGreaterThan(-1);
    expect(archivedAtIdx).toBeGreaterThan(deletePolicyIdx);
  });
});
