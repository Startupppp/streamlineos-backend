import { DrizzleCommandFenceStore } from "./command-fence-store";
import { getTenantContext, runWithTenantContext } from "../tenant/tenant-context";
import type { TenantTx } from "../tenant/with-tenant";
import type { Db } from "../../db/drizzle.module";

/**
 * The fence must open a tenant transaction of its own when there is not one already.
 *
 * `command_fences` is RLS-enabled with `tenant_isolation` = `organization_id =
 * current_org_id()`, and `current_org_id()` RAISES `42501` when `app.organization_id`
 * is unset — it is the raising variant, not `_or_null`, so there is no quiet zero-row
 * answer to mistake for a miss. Measured against the live schema as the non-owner
 * `streamline_app` role:
 *
 *   no GUC   → ERROR: no tenant context: app.organization_id is not set for this transaction
 *   with GUC → passes the policy (reaches the FK check)
 *
 * The store used to issue all three statements through the bare injected `DRIZZLE`
 * proxy, which routes to the ambient tenant transaction when there is one and falls
 * through to the pool with NO GUC when there is not. So `@Idempotent` on a handler that
 * also carried `@NoTenantTransaction()` did not merely lose its fence — it 500'd on the
 * first statement, before the handler ran. That is why `POST /kb/ask`,
 * `POST /kb/pages/:pageId/reindex` and `POST /kb/pages/reindex-all` could not simply be
 * decorated: all three must run outside the request transaction because each awaits a
 * provider round trip.
 *
 * These tests assert on `withTenant`'s observable effect rather than on the SQL: a
 * transaction is opened, and `app.organization_id` is set inside it before the fence
 * statement runs.
 */

const ORG = "org-fence-no-ambient";

interface Recorded {
  transactions: number;
  configuredOrgIds: string[];
  statements: string[];
}

function makeDb(): { db: Db; recorded: Recorded } {
  const recorded: Recorded = { transactions: 0, configuredOrgIds: [], statements: [] };

  const tx = {
    execute: async (query: unknown) => {
      const text = JSON.stringify(query);
      recorded.statements.push("execute");
      const match = /set_config[^]*?organization_id/.test(text);
      if (match) {
        const org = /org-[a-z0-9-]+/.exec(text)?.[0];
        if (org) recorded.configuredOrgIds.push(org);
      }
      return [];
    },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            recorded.statements.push("insert");
            if (!getTenantContext())
              throw new Error("42501: fence insert ran with no tenant context");
            return [{ fenceId: 42 }];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          recorded.statements.push("update");
          if (!getTenantContext())
            throw new Error("42501: fence update ran with no tenant context");
          return [];
        },
      }),
    }),
  };

  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      recorded.transactions += 1;
      return fn(tx);
    },
    ...tx,
  } as unknown as Db;

  return { db, recorded };
}

describe("DrizzleCommandFenceStore with no ambient tenant transaction", () => {
  it("opens one and sets app.organization_id before claiming", async () => {
    const { db, recorded } = makeDb();
    expect(getTenantContext()).toBeUndefined();

    const result = await new DrizzleCommandFenceStore(db).claim({
      orgId: ORG,
      audience: "internal",
      idempotencyKey: "key-1",
      commandName: "kb.ask",
      requestHash: "hash-1",
      principalId: "user-1",
    });

    expect(result).toEqual({ kind: "proceed", fenceId: 42 });
    expect(recorded.transactions).toBe(1);
    expect(recorded.configuredOrgIds).toContain(ORG);
    expect(recorded.statements).toContain("insert");
  });

  it("opens one for the COMPLETED stamp too", async () => {
    const { db, recorded } = makeDb();
    await new DrizzleCommandFenceStore(db).complete(42, 200, { answer: "x" }, ORG);

    expect(recorded.transactions).toBe(1);
    expect(recorded.configuredOrgIds).toContain(ORG);
    expect(recorded.statements).toContain("update");
  });

  it("opens one for the FAILED stamp too, and does not swallow the org", async () => {
    const { db, recorded } = makeDb();
    await new DrizzleCommandFenceStore(db).fail(42, ORG);

    expect(recorded.transactions).toBe(1);
    expect(recorded.configuredOrgIds).toContain(ORG);
    expect(recorded.statements).toContain("update");
  });

  /**
   * The other half of the contract, and the one a careless "just wrap everything"
   * would break: inside a request transaction the fence statement must go ON that
   * transaction, not on a second one. A separate transaction would commit the claim
   * independently of the command it fences, so a rolled-back money command would
   * leave a COMPLETED fence behind and its legitimate retry would replay a success
   * that never happened.
   */
  it("reuses the request transaction when one is already open", async () => {
    const { db, recorded } = makeDb();
    const ambientTx = { marker: "ambient" } as unknown as TenantTx;

    await runWithTenantContext({ orgId: ORG, audience: "INTERNAL", tx: ambientTx }, () =>
      new DrizzleCommandFenceStore(db).complete(42, 200, { answer: "x" }, ORG),
    );

    expect(recorded.transactions).toBe(0);
    expect(recorded.statements).toContain("update");
  });

  it("refuses to open a transaction for a different org than the ambient one", async () => {
    const { db } = makeDb();
    const ambientTx = { marker: "ambient" } as unknown as TenantTx;

    await expect(
      runWithTenantContext({ orgId: "org-other", audience: "INTERNAL", tx: ambientTx }, () =>
        new DrizzleCommandFenceStore(db).claim({
          orgId: ORG,
          audience: "internal",
          idempotencyKey: "key-1",
          commandName: "kb.ask",
          requestHash: "hash-1",
          principalId: "user-1",
        }),
      ),
    ).rejects.toThrow(/refusing to open a transaction for org/);
  });
});
