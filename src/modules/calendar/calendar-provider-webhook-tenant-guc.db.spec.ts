/**
 * The regression net for the P0 that made `POST /webhooks/calendar/provider` answer 500
 * to every well-formed, correctly-secreted delivery.
 *
 * THE DEFECT. `CalendarProviderWebhookController` is `@Public()`. With no session,
 * `TenantContextInterceptor.resolveTenant` returns null, the interceptor calls
 * `next.handle()` WITHOUT opening a tenant transaction, and `createTenantAwareDb`
 * (tenant-db.ts:20) therefore falls through to the raw pool with no ambient context.
 * `handleDelivery` opened with a bare `this.db.select().from(userIntegrationConnections)`
 * on that handle. `user_integration_connections` carries `relrowsecurity = t` with
 * `USING (org_id = app.current_org_id())`, and `app.current_org_id()` RAISES 42501 when
 * `app.organization_id` is unset rather than returning NULL. Measured against
 * scratch_head_1010 as `streamline_app` with no GUC:
 *
 *   ERROR:  no tenant context: app.organization_id is not set for this transaction
 *   CONTEXT:  PL/pgSQL function current_org_id() line 7 at RAISE
 *
 * So a valid Google/Outlook change notification 500s, the provider retries, it 500s
 * again, and the drift-reconciliation half of PRD-C129 never executes for any tenant.
 * The route is unreachable in both configurations: unset secret 503s, set secret 500s.
 *
 * THE FIX is the shape this repo already uses for exactly this problem — an inbound
 * webhook that must find its tenant before it holds one. Migrations 0385/0386/0387
 * introduced `app.resolve_project_org_id`, `app.resolve_survey_session_org_id` and
 * `app.resolve_git_connection_org_id`: SECURITY DEFINER, owner-owned, returning the
 * org id and NOTHING else, EXECUTE granted to the app role. The connection row itself
 * is then re-read inside `runInNewTenantTransaction(orgId, …)`, where RLS is live and
 * the status/toolkit predicate is enforced. Widening the table's own policy with an
 * `id`-keyed arm was rejected for the reason 0387's header already gives: it would
 * grant blanket read of the FULL row to every unguarded id-only query, and this table
 * holds `composio_connected_account_id`.
 *
 *   CATALOG — the real thing. Proves against a live Postgres as the non-owner app role
 *   that the bare read is denied, that the resolver answers without a GUC, that it is
 *   SECURITY DEFINER and executable by the app role, and that it exposes org_id alone.
 *   Every write is rolled back.
 *
 *   APP_DATABASE_URL=postgresql://streamline_app:…@…/scratch_head_1010 \
 *     pnpm test:db-specs --testNamePattern="calendar connection resolver — real catalog"
 */
import postgres from "postgres";

const RESOLVER = "resolve_calendar_connection_org_id";
const DB_URL = process.env.CALENDAR_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;
if (!DB_URL)
  throw new Error(
    "calendar-provider-webhook-tenant-guc.db.spec requires CALENDAR_PROBE_DATABASE_URL or APP_DATABASE_URL",
  );

/** Drizzle and postgres-js both wrap driver errors; the SQLSTATE can be on `.cause`. */
function sqlstateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let hop = 0; hop < 6 && cursor !== null && cursor !== undefined; hop++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe("calendar connection resolver — real catalog, non-owner role", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("connects as a role RLS actually applies to", async () => {
    // Anti-vacuity: as an owner with rolbypassrls the denial below cannot happen, so a
    // green suite would mean nothing. Refuse to pass on the wrong role.
    const rows = await sql`select rolbypassrls from pg_roles where rolname = current_user`;
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("is SECURITY DEFINER, owner-owned, and executable by the app role", async () => {
    const rows = await sql`
      select p.prosecdef,
             pg_get_userbyid(p.proowner) as owner,
             has_function_privilege(current_user, p.oid, 'EXECUTE') as executable,
             pg_get_function_result(p.oid) as result_type
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = ${RESOLVER}`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.prosecdef).toBe(true);
    expect(rows[0]?.executable).toBe(true);
    // org_id and nothing else: this path must never widen to the whole row, which
    // carries composio_connected_account_id.
    expect(rows[0]?.result_type).toBe("text");
  });

  it("answers with no tenant GUC, where the bare row read is denied 42501", async () => {
    await sql.begin(async (tx) => {
      const [org] = await tx`select id from organizations order by id limit 1`;
      if (!org) throw new Error("scratch database has no organization to probe with");
      const orgId: string = String(org.id);

      // Seed one connection inside the transaction, with the GUC set so the policy's
      // WITH CHECK admits the write.
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      const [connection] = await tx`
        insert into user_integration_connections
          (org_id, user_id, toolkit, composio_connected_account_id, status)
        values (${orgId}, 'probe-user', 'googlecalendar', ${"probe-" + Date.now()}, 'active')
        returning id`;
      const connectionId = Number(connection?.id);

      // Now drop the GUC: this is the state a @Public() webhook request runs in.
      await tx`select set_config('app.organization_id', '', true)`;

      // The denied read must sit in a SAVEPOINT: a failed statement aborts the whole
      // transaction (25P02) and every probe after it would fail for the wrong reason.
      let denied: unknown;
      await tx
        .savepoint(
          async (sp) =>
            sp`select id, org_id from user_integration_connections where id = ${connectionId}`,
        )
        .catch((error: unknown) => {
          denied = error;
        });
      expect(sqlstateOf(denied)).toBe("42501");

      const resolved = await tx`select app.resolve_calendar_connection_org_id(${connectionId}) as org_id`;
      expect(resolved[0]?.org_id).toBe(orgId);

      const missing = await tx`select app.resolve_calendar_connection_org_id(${-1}) as org_id`;
      expect(missing[0]?.org_id).toBeNull();

      // Leave the database as it was found.
      throw new Error("rollback");
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "rollback") throw error;
    });
  });
});
