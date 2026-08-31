import { NotFoundException } from "@nestjs/common";
import { BankAccountsService } from "./bank-accounts.service";
import type { Db } from "../../../db/drizzle.module";
import type { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AuditService } from "../../../common/audit/audit.service";

type MockDb = {
  query: {
    finBankAccounts: { findFirst: jest.Mock };
  };
};

type CacheCall = {
  namespace: string;
  itemKey: string;
};

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

function makeService(db: MockDb, cacheCalls: CacheCall[]) {
  const cache = {
    cachedVersioned: jest.fn(
      async (namespace: string, itemKey: string, load: () => Promise<unknown>) => {
        cacheCalls.push({ namespace, itemKey });
        return load();
      },
    ),
  };

  return new BankAccountsService(
    db as unknown as Db,
    {} as FinancePostingService,
    cache as unknown as CacheService,
    {} as AuditService,
  );
}

describe("BankAccountsService.findOne — cross-tenant isolation", () => {
  const BANK_ACCOUNT_ID = 41;

  it("does not reveal a bank account when the same id is requested from another organization", async () => {
    const db: MockDb = {
      query: { finBankAccounts: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    };
    const cacheCalls: CacheCall[] = [];
    const service = makeService(db, cacheCalls);

    await expect(service.findOne("org-attacker", BANK_ACCOUNT_ID)).rejects.toThrow(NotFoundException);

    expect(db.query.finBankAccounts.findFirst).toHaveBeenCalledTimes(1);
    const query = db.query.finBankAccounts.findFirst.mock.calls[0]?.[0] as { where?: unknown };
    expect(sqlValues(query.where)).toContain("org-attacker");
    expect(cacheCalls).toEqual([
      expect.objectContaining({ namespace: expect.stringContaining("org-attacker"), itemKey: String(BANK_ACCOUNT_ID) }),
    ]);
  });

  it("keeps cache namespaces separate for the same bank-account id in different organizations", async () => {
    const db: MockDb = {
      query: { finBankAccounts: { findFirst: jest.fn().mockResolvedValue({ id: BANK_ACCOUNT_ID }) } },
    };
    const cacheCalls: CacheCall[] = [];
    const service = makeService(db, cacheCalls);

    await service.findOne("org-a", BANK_ACCOUNT_ID);
    await service.findOne("org-b", BANK_ACCOUNT_ID);

    expect(cacheCalls).toHaveLength(2);
    expect(cacheCalls[0]?.namespace).toContain("org-a");
    expect(cacheCalls[1]?.namespace).toContain("org-b");
    expect(cacheCalls[0]?.namespace).not.toBe(cacheCalls[1]?.namespace);
  });
});
