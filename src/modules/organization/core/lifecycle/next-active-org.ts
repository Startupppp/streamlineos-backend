import { sql, type SQL } from "drizzle-orm";

/**
 * One statement for the whole departing cohort, replacing one `withIdentity`
 * transaction per member.
 *
 * The set form is only expressible through `app.next_active_org_ids` (migration
 * 1081). Policy `tenant_isolation` on `organization_members` is
 * `USING (org_id = app.current_org_id_or_null() OR user_id = app.current_user_id_or_null())`:
 * the org arm cannot reach the other organisations the answer lives in, and the
 * identity arm admits one principal because `app.user_id` is a single text GUC.
 *
 * Caller must run this inside a tenant transaction pinned to the organisation
 * being archived or purged — the function reads `app.current_org_id()` both to
 * exclude that organisation and to fence the subject set to its own members, and
 * raises 42501 when the GUC is absent.
 *
 * `ARRAY[...]` is not decoration. Interpolating the JS array directly renders the
 * row constructor `($1, $2, $3)::text[]`, which fails 42809 at runtime; the
 * rendered form is pinned in next-active-org.spec.ts.
 */
export function nextActiveOrgIdsQuery(memberUserIds: readonly string[]): SQL {
  const ids = sql.join(
    memberUserIds.map((memberUserId) => sql`${memberUserId}`),
    sql`, `,
  );
  return sql`SELECT user_id, next_org_id FROM app.next_active_org_ids(ARRAY[${ids}]::text[])`;
}
