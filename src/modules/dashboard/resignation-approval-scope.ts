import { and, eq, sql } from "drizzle-orm";
import { hrEmployments, hrPeople, hrReportingLines, resignations } from "../../db/schema";
import type { OwnershipScope } from "../access/scoped-read";

export function resignationApprovalScope(orgId: string, actorUserId: string): OwnershipScope {
  const canonicalDirectReport = sql`EXISTS (
    SELECT 1
    FROM ${hrReportingLines} rl
    INNER JOIN ${hrEmployments} me ON me.id = rl.manager_employment_id
      AND me.org_id = ${orgId} AND me.is_primary = true AND me.deleted_at IS NULL
    INNER JOIN ${hrPeople} mp ON mp.id = me.person_id
      AND mp.org_id = ${orgId} AND mp.deleted_at IS NULL AND mp.user_id = ${actorUserId}
    INNER JOIN ${hrEmployments} ee ON ee.id = rl.employment_id
      AND ee.org_id = ${orgId} AND ee.is_primary = true AND ee.deleted_at IS NULL
    INNER JOIN ${hrPeople} ep ON ep.id = ee.person_id
      AND ep.org_id = ${orgId} AND ep.deleted_at IS NULL AND ep.user_id = ${resignations.userId}
    WHERE rl.org_id = ${orgId}
      AND rl.line_type = 'primary'
      AND rl.effective_from <= CURRENT_DATE AND rl.effective_to >= CURRENT_DATE
  )`;
  return {
    own: canonicalDirectReport,
    team: and(canonicalDirectReport, eq(resignations.userId, actorUserId)) ?? sql`false`,
  };
}
