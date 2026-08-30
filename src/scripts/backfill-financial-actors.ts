import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { sql } from "drizzle-orm";
import { AppModule } from "../app.module";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";
import { organizations } from "../db/schema";
import { resolveOrganizationActorsByUserIds } from "../common/organization/organization-actor";

const SOURCES = [
  ["purchase_bills", "created_by"],
  ["fin_payment_runs", "created_by"],
  ["acc_tax_payments", "created_by"],
  ["fin_reimbursement_batches", "created_by"],
  ["fin_bank_transfers", "created_by"],
  ["fin_approval_requests", "requested_by"],
  ["payment_test_transactions", "created_by"],
  ["payment_provider_credentials", "created_by"],
  ["enterprise_quotes", "created_by_id"],
  ["billing_invoice_snapshots", "created_by"],
  ["billing_credit_notes", "created_by"],
] as const;

type Source = (typeof SOURCES)[number];
type Candidate = { id: number; orgId: string; userId: string };

async function scanSource(db: Db, source: Source, orgId: string, after: number): Promise<Candidate[]> {
  const [table, column] = source;
  const rows = await db.execute<{ id: number; org_id: string; user_id: string | null }>(sql`
    SELECT id, org_id, ${sql.raw(column)} AS user_id
    FROM ${sql.raw(table)}
    WHERE org_id = ${orgId} AND id > ${after} AND ${sql.raw(column)} IS NOT NULL
    ORDER BY id ASC
    LIMIT 500
  `);
  return rows.map((row) => ({ id: Number(row.id), orgId: row.org_id, userId: String(row.user_id) }));
}

async function main(): Promise<void> {
  const requestedOrg = process.argv[2];
  const requestedSource = process.argv[3];
  const after = Number(process.argv[4] ?? 0);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });

  try {
    const db = app.get<Db>(DRIZZLE);
    const orgs = requestedOrg ? [{ id: requestedOrg }] : await db.select({ id: organizations.id }).from(organizations);
    const sources = requestedSource
      ? SOURCES.filter(([table]) => table === requestedSource)
      : SOURCES;
    if (sources.length === 0) throw new Error(`Unknown financial actor source: ${requestedSource}`);

    for (const org of orgs) {
      for (const source of sources) {
        const candidates = await scanSource(db, source, org.id, after);
        const actors = await resolveOrganizationActorsByUserIds(db, org.id, candidates.map((row) => row.userId));
        const unresolved = candidates.filter((row) => !actors.has(row.userId));
        console.log(JSON.stringify({
          orgId: org.id,
          source: source[0],
          scanned: candidates.length,
          resolved: candidates.length - unresolved.length,
          unresolved: unresolved.map((row) => ({ id: row.id, userId: row.userId })),
          nextAfter: candidates.at(-1)?.id ?? after,
        }));
      }
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
