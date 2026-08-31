import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { TenantTx } from "../../../db/drizzle.types";
import { readCount } from "./quota-counts";

function lockNumbering(orgId: string, prefix: string, year: number) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice:${orgId}:${prefix}:${year}`}, 0))`;
}

/** The number comes from a row incremented under a lock, so it is gapless per prefix and year and auditable. */
export async function allocateDocumentNumber(
  tx: TenantTx,
  orgId: string,
  prefix: string,
  year: number,
): Promise<string> {
  if (!/^[A-Z0-9-]{1,20}$/.test(prefix))
    throw new BadRequestException("Invoice prefix must be A-Z, 0-9 or -");

  await tx.execute(lockNumbering(orgId, prefix, year));

  const rows = await tx.execute(sql`
    INSERT INTO billing_invoice_number_sequences (org_id, prefix, year, last_number, updated_at)
    VALUES (${orgId}, ${prefix}, ${year}, 1, NOW())
    ON CONFLICT (org_id, prefix, year)
    DO UPDATE SET last_number = billing_invoice_number_sequences.last_number + 1, updated_at = NOW()
    RETURNING last_number
  `);

  return `${prefix}-${year}-${String(readCount(rows, "last_number")).padStart(6, "0")}`;
}
