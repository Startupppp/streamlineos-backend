/**
 * INV-109 — tenant isolation as a role that cannot bypass it.
 *
 * The owner role Neon hands out has BYPASSRLS, so every policy is inert against
 * it and a suite run as the owner proves nothing: a table with no policy at all
 * reads exactly the same. These probes run as a NOBYPASSRLS role and cover the
 * four cases the PRD names — correct tenant, missing tenant, wrong tenant, and
 * the real application role — plus the one that makes the whole suite honest:
 * the role under test must not be able to bypass.
 *
 *   INV_DB_TESTS=1 npx jest --runInBand --testPathPattern="inventory-rls"
 *
 * Prefers APP_DATABASE_URL when set, which is the deployed application role. If
 * it is absent this creates a NOBYPASSRLS probe role with the same grants and
 * drops it afterwards, so the check still runs where those credentials are not
 * available — and it refuses to pass as a bypassing role either way.
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";

const ENABLED = process.env.INV_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

const PROBE_ROLE = "inv_rls_probe";

/** SET ROLE needs a session-mode connection; Neon encodes that in the host. */
function sessionUrl(raw: string): string {
  const url = new URL(raw.replace("-pooler.", "."));
  url.searchParams.delete("channel_binding");
  return url.toString();
}

/** A representative table from each area of the inventory surface. */
const TENANT_TABLES = [
  "inv_products",
  "inv_stock_levels",
  "inv_stock_transactions",
  "inv_purchase_orders",
  "inv_po_lines",
  "inv_reason_codes",
  "inv_webhook_event_subscriptions",
] as const;

/**
 * Runs setup work, retrying once, and names the step when it still fails.
 *
 * A throw in beforeAll fails every test in the file with jest's own message, so
 * the cause is invisible — seventeen assertions "failing" when one GRANT was
 * blocked by connections another suite had not finished draining.
 */
async function withContext<T>(step: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    try {
      return await work();
    } catch (second) {
      const firstDetail = first instanceof Error ? first.message : String(first);
      throw new Error(`${step} failed twice; first attempt: ${firstDetail}`, { cause: second });
    }
  }
}

describeDb("inventory row-level security", () => {
  let owner: ReturnType<typeof postgres>;
  let usingDeployedRole = false;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
    const ownerUrl = process.env.DATABASE_URL;
    if (!ownerUrl) throw new Error("DATABASE_URL required for INV_DB_TESTS");
    owner = postgres(sessionUrl(ownerUrl), {
      prepare: false,
      max: 2,
      onnotice: () => undefined,
      // A blocked GRANT should say so rather than sit behind another suite's
      // locks until the jest timeout turns it into an unexplained failure.
      connection: { lock_timeout: "5s" } as never,
    });

    usingDeployedRole = Boolean(process.env.APP_DATABASE_URL);
    if (!usingDeployedRole) {
      // Setup failures used to surface as seventeen unexplained assertion
      // failures, because a beforeAll that throws fails every test in the file
      // with its own message rather than the cause. Run straight after the
      // seeded e2e suites, the GRANT below contends with connections still
      // draining — so it says which statement failed, and retries once.
      await withContext("probe role setup", async () => {
        await owner.unsafe(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}')
            THEN CREATE ROLE ${PROBE_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
          END $$;`);
        await owner.unsafe(`GRANT USAGE ON SCHEMA public, app TO ${PROBE_ROLE}`);
      // Only the tables under test. `ON ALL TABLES IN SCHEMA public` takes a
      // lock on all 735 of them, which collided with the other database suites
      // and failed this whole file roughly one run in three — as a beforeAll
      // failure, so it read as seventeen broken assertions rather than one
      // contended GRANT.
        await owner.unsafe(
          `GRANT SELECT, INSERT ON ${TENANT_TABLES.join(", ")} TO ${PROBE_ROLE}`,
        );
        await owner.unsafe(`GRANT EXECUTE ON FUNCTION app.current_org_id() TO ${PROBE_ROLE}`);
        await owner.unsafe(`GRANT ${PROBE_ROLE} TO CURRENT_USER`);
      });
    }

    const orgs = await owner<{ id: string }[]>`SELECT id FROM organizations ORDER BY created_at LIMIT 2`;
    orgA = orgs[0]!.id;
    orgB = orgs[1]?.id ?? orgs[0]!.id;
  });

  afterAll(async () => {
    if (owner && !usingDeployedRole) {
      // DROP ROLE refuses while any grant still references the role, and
      // REVOKE alone does not cover them all — DROP OWNED BY does. Swallowing
      // the failure silently is what left the role behind the first time, so
      // this reports instead: a role that outlives the suite keeps collecting
      // grants on every table added afterwards.
      try {
        await owner.unsafe(`DROP OWNED BY ${PROBE_ROLE}`);
        await owner.unsafe(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
      } catch (error) {
        console.warn(`could not drop ${PROBE_ROLE}: ${(error as Error).message}`);
      }
    }
    if (owner) await owner.end({ timeout: 5 });
  });

  /**
   * One statement, as the restricted role, in its own transaction.
   *
   * Its own transaction because a policy violation raises, and Postgres aborts
   * the whole transaction on a statement error — sharing one would make the
   * first expected failure poison every later probe.
   */
  async function asRestrictedRole<T>(
    orgId: string | null,
    body: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
    try {
      const value = await owner.begin(async (tx) => {
        if (!usingDeployedRole) await tx.unsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
        if (orgId !== null) await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
        return body(tx);
      });
      return { ok: true, value: value as T };
    } catch (error) {
      return { ok: false, code: (error as { code?: string }).code ?? "unknown" };
    }
  }

  it("runs as a role that cannot bypass row-level security", async () => {
    const result = await asRestrictedRole(orgA, (tx) =>
      tx<{ role: string; bypass: boolean }[]>`
        SELECT current_user AS role,
               (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Without this the entire suite passes vacuously against the owner role.
    expect(result.value[0]!.bypass).toBe(false);
  });

  it.each(TENANT_TABLES)("%s denies a read with no tenant context", async (table) => {
    const result = await asRestrictedRole(null, (tx) => tx.unsafe(`SELECT count(*) FROM ${table}`));
    expect(result).toEqual({ ok: false, code: "42501" });
  });

  it.each(TENANT_TABLES)("%s returns only the tenant in context", async (table) => {
    const result = await asRestrictedRole(orgA, (tx) =>
      tx.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE org_id <> $1`, [orgA]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = result.value as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(0);
  });

  it("shows a row to its own tenant and hides it from another", async () => {
    if (orgA === orgB) {
      throw new Error("this database has fewer than two organisations; the cross-tenant probe cannot run");
    }
    const code = `RLS-${randomUUID().slice(0, 8)}`;
    await owner`
      INSERT INTO inv_reason_codes (org_id, code, label, category)
      VALUES (${orgA}, ${code}, 'RLS probe', 'ADJUSTMENT')`;
    try {
      const visible = await asRestrictedRole(orgA, (tx) =>
        tx<{ n: number }[]>`SELECT count(*)::int AS n FROM inv_reason_codes WHERE code = ${code}`,
      );
      const hidden = await asRestrictedRole(orgB, (tx) =>
        tx<{ n: number }[]>`SELECT count(*)::int AS n FROM inv_reason_codes WHERE code = ${code}`,
      );
      expect(visible.ok && visible.value[0]!.n).toBe(1);
      expect(hidden.ok && hidden.value[0]!.n).toBe(0);
    } finally {
      await owner`DELETE FROM inv_reason_codes WHERE code = ${code}`;
    }
  });

  it("refuses a write that claims a different tenant than the context", async () => {
    if (orgA === orgB) return;
    const code = `RLS-${randomUUID().slice(0, 8)}`;
    const result = await asRestrictedRole(orgA, (tx) =>
      tx`INSERT INTO inv_reason_codes (org_id, code, label, category)
         VALUES (${orgB}, ${code}, 'RLS probe', 'ADJUSTMENT')`,
    );
    // WITH CHECK rejects the row rather than writing it into the wrong tenant.
    expect(result).toEqual({ ok: false, code: "42501" });
    const leaked = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM inv_reason_codes WHERE code = ${code}`;
    expect(leaked[0]!.n).toBe(0);
  });
});
