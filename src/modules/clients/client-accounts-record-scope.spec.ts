import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ClientAccountsService } from "./client-accounts.service";
import { ScopedRead } from "../access/scoped-read";

/**
 * The client list narrowed by `DataScope`; four routes reached by id did not.
 *
 * `crm:clients:read` is declared `scopable: true`. `getClientAccounts` narrows
 * with `applyClientAccountsScope(..., { ownerColumn: clientAccounts.salesRepId })`,
 * `listRenewals` narrows, `loadClientAccount` narrows. The activity trail — which
 * `loadClientAccount` returns as part of the detail it narrows — did not, and
 * neither did any of the three writes that take an account id.
 *
 * The write side is not a separate question. The route key is
 * `crm:clients:update`, which the catalog does not declare scopable, but WHICH
 * RECORD YOU MAY ACT ON is the same question as which record you may open, and
 * two of the three hand the whole `client_accounts` row back in the response.
 *
 * The compiled predicate is the assertion. Every fixture below answers the same
 * account whatever the WHERE says, so "it returned null" would pass against the
 * unscoped code too.
 */

const sqlText = (statement: SQL): string => new PgDialect().sqlToQuery(statement).sql;

/** `applyClientAccountsScope` at `own`, as Postgres sees it. */
const OWNER_PREDICATE = '"sales_rep_id" =';

interface Recorder {
  db: never;
  wheres: SQL[];
}

/**
 * A db that records every `where` it is handed and always finds the account.
 *
 * `transaction` invokes its callback — a bare `jest.fn()` would silently void
 * every assertion about the UPDATE that `updateStatus` runs inside it.
 */
function recording(): Recorder {
  const wheres: SQL[] = [];

  const returning = () => Promise.resolve([{ id: 7, clientName: "Acme" }]);
  const insert = () => ({
    values: () => ({
      returning,
      then: (resolve: (value: unknown[]) => unknown) => resolve([{ id: 1 }]),
    }),
  });
  const update = () => ({
    set: () => ({
      where: (predicate: SQL) => {
        wheres.push(predicate);
        return { returning };
      },
    }),
  });

  const handle = {
    query: {
      clientAccounts: {
        findFirst: (args: { where: SQL }) => {
          wheres.push(args.where);
          return Promise.resolve({
            id: 7,
            orgId: "org-1",
            salesRepId: "rep-2",
            branchId: null,
            clientName: "Acme",
          });
        },
      },
      clientAccountActivities: { findMany: () => Promise.resolve([]) },
    },
    insert,
    update,
  };

  const db = {
    ...handle,
    transaction: (work: (tx: unknown) => Promise<unknown>) => work(handle),
  } as unknown as never;

  return { db, wheres };
}

function serviceWith(rec: Recorder): ClientAccountsService {
  const audit = { log: () => undefined } as never;
  const clientsEmail = { sendInvestmentEmails: () => Promise.resolve() } as never;
  const access = {
    membersWithPermission: (_orgId: string, _key: string) => Promise.resolve([]),
  } as never;
  return new ClientAccountsService(rec.db, null, audit, clientsEmail, access);
}

const allSql = (rec: Recorder): string => rec.wheres.map(sqlText).join("\n---\n");

describe("client account routes reached by id honour the read scope", () => {
  describe("getClientActivities", () => {
    it("narrows the parent lookup to the accounts the caller may read", async () => {
      const rec = recording();

      await serviceWith(rec).getClientActivities(ScopedRead.of("org-1", "rep-1", "own"), 7);

      expect(allSql(rec)).toContain(OWNER_PREDICATE);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getClientActivities(ScopedRead.of("org-1", "manager-1", "all"), 7);

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });

    it("reaches no account at scope none", async () => {
      const rec = recording();

      await serviceWith(rec).getClientActivities(ScopedRead.of("org-1", "rep-1", "none"), 7);

      expect(allSql(rec)).toContain("false");
    });
  });

  describe("updateRenewal", () => {
    it("narrows both the check and the UPDATE itself", async () => {
      /*
       * The check alone would leave the write keyed on nothing but an id. Two
       * predicates carry it, and counting them is what tells a real fix from one
       * applied to the lookup and not to the statement.
       */
      const rec = recording();

      await serviceWith(rec).updateRenewal(ScopedRead.of("org-1", "rep-1", "own"), 7, {});

      const owned = allSql(rec).split(OWNER_PREDICATE).length - 1;
      expect(owned).toBe(2);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).updateRenewal(ScopedRead.of("org-1", "manager-1", "all"), 7, {});

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });

    it("reaches no account at scope none", async () => {
      // `.returning()` names no columns, so an unscoped PATCH that changed
      // nothing was a working detail-read of any account by id.
      const rec = recording();

      await serviceWith(rec).updateRenewal(ScopedRead.of("org-1", "rep-1", "none"), 7, {});

      expect(allSql(rec)).toContain("false");
    });
  });

  describe("addActivity", () => {
    it("narrows the account it appends to", async () => {
      const rec = recording();

      await serviceWith(rec).addActivity(ScopedRead.of("org-1", "rep-1", "own"), 7, { activityType: "note", title: "Called" });

      expect(allSql(rec)).toContain(OWNER_PREDICATE);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).addActivity(ScopedRead.of("org-1", "manager-1", "all"), 7, { activityType: "note", title: "Called" });

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });
  });

  describe("updateStatus", () => {
    it("narrows both the check and the UPDATE inside the transaction", async () => {
      /*
       * The most expensive one to leave open: marking an account INVESTED mints
       * an `incentives` row against that account's OWN sales rep, notifies them
       * and emails them, all from a caller who could not open the account.
       */
      const rec = recording();

      await serviceWith(rec).updateStatus(ScopedRead.of("org-1", "rep-1", "own"), 7, { status: "QUERIES" });

      const owned = allSql(rec).split(OWNER_PREDICATE).length - 1;
      expect(owned).toBe(2);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).updateStatus(ScopedRead.of("org-1", "manager-1", "all"), 7, { status: "QUERIES" });

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });

    it("reaches no account at scope none", async () => {
      const rec = recording();

      await serviceWith(rec).updateStatus(ScopedRead.of("org-1", "rep-1", "none"), 7, { status: "QUERIES" });

      expect(allSql(rec)).toContain("false");
    });
  });

  describe("getCrmAssignmentStats", () => {
    it("is deliberately not narrowed, and says so where a census will read it", () => {
      /*
       * A census flags this exactly like the four above — `crm:clients:read`,
       * scopable, no caller id — and narrowing it would break it. The figure is
       * how many accounts each customer-success member carries, read immediately
       * before the round-robin that rebalances them; `sales_rep_id = me` turns it
       * into "how many of MY accounts is each member carrying", which no screen
       * asks and which the assignment does not balance against.
       *
       * Pinned as source, not behaviour, because the correct behaviour here is
       * the absence of a predicate and there is no way to assert an absence
       * without also asserting it stayed deliberate. The next agent to run the
       * census gets the reasoning instead of re-filing it.
       *
       * Matching the code form rather than a word: this looks for the method's
       * own signature keeping `orgId` as its only parameter, which is the thing
       * that would change if somebody narrowed it.
       */
      /*
       * Two files since 40568c0b9 split the backfill out: the service method is
       * a one-line delegate, and the query lives in
       * `lib/client-account-backfill.ts`. Narrowing it would have to change one
       * signature or the other, so both are pinned. The reasoning stays on the
       * service method, which is where a census walking route -> service lands --
       * and it is matched as that method's own doc block, so the sentence cannot
       * drift away from the code it explains and still pass.
       */
      const service = readFileSync(join(__dirname, "client-accounts.service.ts"), "utf8");
      const lib = readFileSync(join(__dirname, "lib", "client-account-backfill.ts"), "utf8");

      expect(service).toMatch(
        /Deliberately NOT narrowed by `DataScope`(?:(?!\*\/)[\s\S])*\*\/\s*getCrmAssignmentStats\(orgId: string\) \{\s*return getCrmAssignmentStats\(this\.backfillDeps, orgId\);/,
      );
      expect(lib).toContain(
        "export async function getCrmAssignmentStats(deps: ClientAccountBackfillDeps, orgId: string) {",
      );
    });
  });
});
