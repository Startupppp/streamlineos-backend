import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import type { AiJob } from "../../../db/schema";
import { isRecord } from "../../../common/types/is-record";

export const FAIR_CLAIM_DEFAULT_PER_ORG_LIMIT = 5;

export class AiJobsFairClaimer {
  private cursorOrgId: string | null = null;

  constructor(private readonly db: Db) {}

  async claim(
    workerId: string,
    limit: number,
    perOrgLimit: number = FAIR_CLAIM_DEFAULT_PER_ORG_LIMIT,
    types?: string[],
  ): Promise<AiJob[]> {
    const now = new Date();

    const orgRows = await this.db.execute(sql`
      SELECT DISTINCT org_id
      FROM ai_jobs
      WHERE status = 'QUEUED'
        AND run_at <= ${now.toISOString()}::timestamptz
      ORDER BY org_id ASC
    `);

    const orgIds = orgRows.map((r) => String(r["org_id"]));
    const rotated = rotateAfter(orgIds, this.cursorOrgId);

    const typeFilter =
      types && types.length > 0
        ? sql`AND type IN (${sql.join(
            types.map((t) => sql`${t}`),
            sql`, `,
          )})`
        : sql``;

    const claimed: AiJob[] = [];
    let lastClaimedOrgId: string | null = null;

    for (const orgId of rotated) {
      if (claimed.length >= limit) break;
      const perOrg = Math.min(perOrgLimit, limit - claimed.length);

      const rows = await this.db.execute(sql`
        UPDATE ai_jobs
        SET status = 'RUNNING',
            locked_by = ${workerId},
            locked_at = ${now.toISOString()}::timestamptz,
            updated_at = ${now.toISOString()}::timestamptz
        WHERE id IN (
          SELECT id FROM ai_jobs
          WHERE status = 'QUEUED'
            AND run_at <= ${now.toISOString()}::timestamptz
            AND org_id = ${orgId}
            ${typeFilter}
          ORDER BY priority DESC, run_at ASC
          LIMIT ${perOrg}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING
          id, org_id, user_id, user_membership_id, type, payload, status, priority,
          attempts, max_attempts, idempotency_key, run_at,
          locked_by, locked_at, last_error, result, correlation_id, created_at, updated_at
      `);

      if (rows.length > 0) {
        claimed.push(...rows.map(mapRow));
        lastClaimedOrgId = orgId;
      }
    }

    this.cursorOrgId = claimed.length >= limit ? lastClaimedOrgId : null;
    return claimed;
  }
}

function rotateAfter(orgIds: string[], afterOrgId: string | null): string[] {
  if (!afterOrgId) return orgIds;
  const idx = orgIds.findIndex((id) => id > afterOrgId);
  if (idx <= 0) return orgIds;
  return [...orgIds.slice(idx), ...orgIds.slice(0, idx)];
}

function mapRow(row: Record<string, unknown>): AiJob {
  return {
    id: Number(row["id"]),
    orgId: String(row["org_id"]),
    userId: row["user_id"] != null ? String(row["user_id"]) : null,
    userMembershipId:
      row["user_membership_id"] != null ? Number(row["user_membership_id"]) : null,
    type: String(row["type"]),
    payload: isRecord(row["payload"]) ? row["payload"] : {},
    status: "RUNNING",
    priority: Number(row["priority"]),
    attempts: Number(row["attempts"]),
    maxAttempts: Number(row["max_attempts"]),
    idempotencyKey:
      row["idempotency_key"] != null ? String(row["idempotency_key"]) : null,
    correlationId:
      row["correlation_id"] != null ? String(row["correlation_id"]) : null,
    runAt: new Date(String(row["run_at"])),
    lockedBy: row["locked_by"] != null ? String(row["locked_by"]) : null,
    lockedAt:
      row["locked_at"] != null ? new Date(String(row["locked_at"])) : null,
    lastError: row["last_error"] != null ? String(row["last_error"]) : null,
    result: isRecord(row["result"]) ? row["result"] : null,
    createdAt: new Date(String(row["created_at"])),
    updatedAt: new Date(String(row["updated_at"])),
  };
}
