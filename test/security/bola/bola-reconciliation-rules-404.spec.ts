import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ReconciliationRulesService } from "src/modules/finance/banking/reconciliation-rules.service";
import type { AuditService } from "src/common/audit/audit.service";
import type { Db } from "src/db/drizzle.module";

/**
 * `GET /finance/reconciliation/:bankAccountId/rules` — found by the live cross-tenant sweep.
 *
 * The route ADDRESSES a bank account and never resolved one. `fin_reconciliation_rules` carries no
 * `bank_account_id` (the rules are org-wide), so the path parameter was passed into the query
 * object and then never read: the list was `WHERE org_id = caller`, full stop. Handed another
 * organization's bank account id — or an id belonging to no organization at all — the route
 * answered 200 with this org's rules, identically. Nothing crossed, but the 404 the contract
 * requires was absent, and the two sibling verbs on the same controller (`createRule`,
 * `deleteRule`) already asserted the account, so the surface disagreed with itself.
 *
 * The refusal must be NotFound. A 403 would confirm the account exists in some other tenant, which
 * is the existence oracle the whole 404 rule exists to prevent.
 */

/** Every value bound into a Drizzle SQL fragment, however deeply nested. */
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
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const CALLER_ORG = "org-b-caller";
const FOREIGN_ACCOUNT_ID = 7788;

interface Probe {
  readonly service: ReconciliationRulesService;
  readonly accountLookups: unknown[];
  readonly listed: number;
}

function makeProbe(accountRow: { id: number } | undefined): Probe {
  const accountLookups: unknown[] = [];
  const state = { listed: 0 };
  const db = {
    query: {
      finBankAccounts: {
        findFirst: jest.fn().mockImplementation((opts: unknown) => {
          accountLookups.push((opts as { where?: unknown } | undefined)?.where);
          return Promise.resolve(accountRow);
        }),
      },
    },
    select: jest.fn().mockImplementation(() => {
      state.listed += 1;
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve([]),
      };
      return chain;
    }),
  } as unknown as Db;

  const audit = { log: jest.fn() } as unknown as AuditService;
  const service = new ReconciliationRulesService(db, audit);
  return {
    service,
    accountLookups,
    get listed() {
      return state.listed;
    },
  };
}

const caller = { orgId: CALLER_ORG, userId: "user-b", sessionId: "s" } as Parameters<
  ReconciliationRulesService["listRules"]
>[0];

describe("BOLA probe — GET /finance/reconciliation/:bankAccountId/rules", () => {
  beforeEach(() => jest.clearAllMocks());

  it("CROSS-TENANT-MISS: another organization's bank account id is refused", async () => {
    const probe = makeProbe(undefined);
    await expect(
      probe.service.listRules(caller, { limit: 20, bankAccountId: FOREIGN_ACCOUNT_ID }),
    ).rejects.toThrow(NotFoundException);
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden", async () => {
    const probe = makeProbe(undefined);
    const thrown = await probe.service
      .listRules(caller, { limit: 20, bankAccountId: FOREIGN_ACCOUNT_ID })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("NO-READ-ON-MISS: no rule row is selected when the account is not the caller's", async () => {
    const probe = makeProbe(undefined);
    await probe.service
      .listRules(caller, { limit: 20, bankAccountId: FOREIGN_ACCOUNT_ID })
      .catch(() => undefined);
    expect(probe.listed).toEqual(0);
  });

  it("PREDICATE-SCOPE: the account is resolved under the CALLER's org, not the path's", async () => {
    const probe = makeProbe(undefined);
    await probe.service
      .listRules(caller, { limit: 20, bankAccountId: FOREIGN_ACCOUNT_ID })
      .catch(() => undefined);
    expect(probe.accountLookups).toHaveLength(1);
    const bound = sqlValues(probe.accountLookups[0]);
    expect(bound).toContain(CALLER_ORG);
    expect(bound).toContain(FOREIGN_ACCOUNT_ID);
  });

  it("SAME-TENANT: the caller's own account still lists, so the guard is not a blanket denial", async () => {
    const probe = makeProbe({ id: FOREIGN_ACCOUNT_ID });
    await expect(
      probe.service.listRules(caller, { limit: 20, bankAccountId: FOREIGN_ACCOUNT_ID }),
    ).resolves.toMatchObject({ data: [] });
    expect(probe.listed).toEqual(1);
  });
});
