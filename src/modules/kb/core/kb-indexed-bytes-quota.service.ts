import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { kbIndexedBytesQuota } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { type TenantTx } from "../../../db/drizzle.types";
import { KbIndexedBytesQuotaExceededException } from "../../../common/http/api-exceptions";

export const KB_DEFAULT_LIMIT_BYTES = 536870912;

export function kbSourceIndexedBytes(source: {
  kind: string;
  noteText?: string | null;
  fileSize?: number | null;
}): number {
  if (source.kind === "note")
    return typeof source.noteText === "string" ? Buffer.byteLength(source.noteText, "utf8") : 0;
  return source.fileSize ?? 0;
}

@Injectable()
export class KbIndexedBytesQuotaService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async reserve(tx: TenantTx, orgId: string, bytes: number): Promise<void> {
    if (bytes <= 0) return;

    await tx
      .insert(kbIndexedBytesQuota)
      .values({ orgId, indexedBytes: 0, limitBytes: KB_DEFAULT_LIMIT_BYTES })
      .onConflictDoNothing({ target: kbIndexedBytesQuota.orgId });

    const [updated] = await tx
      .update(kbIndexedBytesQuota)
      .set({
        indexedBytes: sql`${kbIndexedBytesQuota.indexedBytes} + ${bytes}`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(kbIndexedBytesQuota.orgId, orgId),
          sql`${kbIndexedBytesQuota.indexedBytes} + ${bytes} <= ${kbIndexedBytesQuota.limitBytes}`,
        ),
      )
      .returning({
        indexedBytes: kbIndexedBytesQuota.indexedBytes,
        limitBytes: kbIndexedBytesQuota.limitBytes,
      });

    if (!updated) {
      const [quota] = await tx
        .select({ limitBytes: kbIndexedBytesQuota.limitBytes })
        .from(kbIndexedBytesQuota)
        .where(eq(kbIndexedBytesQuota.orgId, orgId))
        .limit(1);
      throw new KbIndexedBytesQuotaExceededException(quota?.limitBytes ?? KB_DEFAULT_LIMIT_BYTES);
    }
  }

  async release(orgId: string, bytes: number): Promise<void> {
    if (bytes <= 0) return;
    await this.db
      .update(kbIndexedBytesQuota)
      .set({
        indexedBytes: sql`greatest(0, ${kbIndexedBytesQuota.indexedBytes} - ${bytes})`,
        updatedAt: sql`now()`,
      })
      .where(eq(kbIndexedBytesQuota.orgId, orgId));
  }
}
