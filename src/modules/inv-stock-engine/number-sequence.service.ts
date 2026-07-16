import { Inject, Injectable } from "@nestjs/common";
import { eq, and, sql } from "drizzle-orm";
import { invNumberSequences } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const DOC_PREFIXES: Record<string, string> = {
  PO: "PO",
  GRN: "GRN",
  SO: "SO",
  TRANSFER: "TRF",
  ADJUSTMENT: "ADJ",
  CYCLE_COUNT: "CC",
  PHYSICAL_AUDIT: "PA",
  VENDOR_RETURN: "VRET",
  CUSTOMER_RETURN: "CRET",
  PICK_LIST: "PICK",
  SHIPMENT: "SHP",
  PACKAGE: "PKG",
  LOAD: "LOAD",
  RECALL: "RCL",
  INSPECTION: "QI",
};

@Injectable()
export class NumberSequenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async next(orgId: string, docType: string, tx?: Tx): Promise<string> {
    const db = tx ?? this.db;
    const prefix = DOC_PREFIXES[docType] ?? docType;

    await db.insert(invNumberSequences)
      .values({ orgId, docType, prefix, nextNumber: 1, padding: 5 })
      .onConflictDoNothing();

    const [row] = await db
      .update(invNumberSequences)
      .set({ nextNumber: sql`${invNumberSequences.nextNumber} + 1` })
      .where(and(eq(invNumberSequences.orgId, orgId), eq(invNumberSequences.docType, docType)))
      .returning({
        prefix: invNumberSequences.prefix,
        nextNumber: invNumberSequences.nextNumber,
        padding: invNumberSequences.padding,
      });

    if (!row) throw new Error(`Number sequence not found for ${docType}`);
    const seq = row.nextNumber - 1;
    return `${row.prefix}-${String(seq).padStart(row.padding, "0")}`;
  }

  getDocTypes(): string[] {
    return Object.keys(DOC_PREFIXES);
  }
}
