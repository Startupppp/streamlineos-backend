import { getTableConfig } from "drizzle-orm/pg-core";
import { autonomousDecisions } from "../../db/schema/crm/autonomous-decisions";
import { autonomySwitches } from "../../db/schema/crm/autonomy-switches";

/**
 * The safety mechanism and the audit trail must survive an offboarding.
 *
 * `scripts/purge-user.mjs` resolves every column carrying a foreign key to
 * `users` and runs `DELETE FROM <table> WHERE <column> = $user`. It does not
 * consult the delete rule, so `ON DELETE SET NULL` protects nothing — the row
 * is deleted outright.
 *
 * On these two tables that is data loss with no error and no log line, which is
 * why it is pinned here rather than left to a comment. Adding the edge back for
 * referential integrity is an entirely reasonable-looking change, and its
 * consequence is invisible until the system starts acting again.
 */
describe("autonomy actor references survive a user purge", () => {
  const usersRef = (table: Parameters<typeof getTableConfig>[0]) =>
    getTableConfig(table).foreignKeys.find((fk) =>
      getTableConfig(fk.reference().foreignTable).name === "users",
    );

  it("autonomy_switches does not reference users", () => {
    // resolveSwitch reports `allowed: true` when no row is found — correctly,
    // because the switches exist to stop autonomy rather than to opt into it.
    // So deleting the row is not a neutral loss: it re-enables the action an
    // operator had killed, silently.
    expect(usersRef(autonomySwitches)).toBeUndefined();
  });

  it("autonomous_decisions does not reference users", () => {
    // The reverser is one field on a record of something else entirely. An edge
    // here means purging them deletes the audit entry for an autonomous action
    // they had nothing to do with.
    expect(usersRef(autonomousDecisions)).toBeUndefined();
  });

  it("keeps the columns themselves, because a ledger still records who acted", () => {
    expect(getTableConfig(autonomySwitches).columns.map((c) => c.name)).toContain(
      "updated_by_user_id",
    );
    expect(getTableConfig(autonomousDecisions).columns.map((c) => c.name)).toContain(
      "reversed_by_user_id",
    );
  });
});
