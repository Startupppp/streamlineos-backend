import type { Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Redis } from "@upstash/redis";
import { type Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import { backfillCrmAssignments } from "./client-accounts-crm-assignment";

const BACKFILL_LOCK_TTL_SECONDS = 60;

export interface ClientAccountsBackfillDeps {
  readonly db: Db;
  readonly redis: Redis | null;
  readonly access: AccessService;
  readonly logger: Logger;
}

export async function runClientAccountsBackfill(
  deps: ClientAccountsBackfillDeps,
  orgId: string,
  userId: string,
): Promise<void> {
  const lockKey = `clients:backfill:${orgId}`;
  if (deps.redis) {
    try {
      const acquired = await deps.redis.set(lockKey, "1", { ex: BACKFILL_LOCK_TTL_SECONDS, nx: true });
      if (!acquired) return;
    } catch (err) {
      deps.logger.warn(`Redis lock acquire failed for client backfill ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await backfillConvertedLeadsToClientAccounts(deps.db, orgId, userId);
  await backfillCrmAssignments(deps.db, deps.access, orgId);
}

/**
 * Opens a client account for every lead that has converted and has none.
 *
 * Reads Party, not `leads`. This was raw SQL against the legacy table, which
 * neither the reader ratchet nor the lint rule could see -- both match Drizzle
 * symbol imports, and a string never imports anything. So it survived every
 * migrate batch, and ticket 08's drop would have taken it out at runtime with
 * nothing having warned.
 *
 * The read is not merely relocated. `leads` is a mirror, and a merge leaves the
 * losing row alive holding the survivor's values while marking only the Party
 * deleted -- so `FROM leads WHERE deleted_at IS NULL` counted one converted
 * customer twice and opened two accounts for them. Joining through
 * `lead_party_map` and filtering on the Party's own `deleted_at` counts the
 * customer.
 *
 * The map is keyed by legacy id and its `party_id` side is deliberately not
 * unique -- after a merge several ids answer to one Party. That is correct
 * here rather than a hazard: `client_accounts.lead_id` is the legacy id, the
 * anti-join is on that id, so each surviving id still gets exactly one account.
 */
export async function backfillConvertedLeadsToClientAccounts(
  db: Db,
  orgId: string,
  fallbackSalesRepId: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO client_accounts (
      org_id, lead_id, sales_rep_id,
      client_name, client_email, client_phone, client_whatsapp,
      estimated_investment, status, converted_at, created_at, updated_at
    )
    SELECT
      m.organization_id,
      m.lead_id,
      COALESCE(p.owner_user_id, ${fallbackSalesRepId}),
      p.name,
      p.email,
      p.phone,
      p.whatsapp_phone,
      COALESCE(p.expected_value, p.stated_budget)::numeric(15,2),
      'ACCOUNT_OPENING'::client_account_status,
      COALESCE(p.converted_at, NOW()),
      NOW(),
      NOW()
    FROM lead_party_map m
    JOIN business_parties p
      ON p.party_id = m.party_id
     AND p.organization_id = m.organization_id
    WHERE m.organization_id = ${orgId}
      AND p.lifecycle_stage = 'CONVERTED'
      AND p.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM client_accounts ca
        WHERE ca.org_id = m.organization_id AND ca.lead_id = m.lead_id
      )
  `);
}
