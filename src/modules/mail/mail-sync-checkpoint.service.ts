import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { mailSyncCheckpoints } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { TenantTx } from "../../db/drizzle.types";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

@Injectable()
export class MailSyncCheckpointService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async loadPosition(
    orgId: string,
    accountId: number,
    folder: string,
  ): Promise<string | null> {
    return runInNewTenantTransaction(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ cursorValue: mailSyncCheckpoints.cursorValue })
        .from(mailSyncCheckpoints)
        .where(
          and(
            eq(mailSyncCheckpoints.orgId, orgId),
            eq(mailSyncCheckpoints.accountId, accountId),
            eq(mailSyncCheckpoints.folder, folder),
          ),
        )
        .limit(1);
      return row?.cursorValue ?? null;
    });
  }

  async savePosition(
    orgId: string,
    accountId: number,
    folder: string,
    cursorValue: string | null,
  ): Promise<void> {
    await runInNewTenantTransaction(this.db, orgId, async (tx) => {
      await tx
        .insert(mailSyncCheckpoints)
        .values({ orgId, accountId, folder, cursorValue })
        .onConflictDoUpdate({
          target: [mailSyncCheckpoints.accountId, mailSyncCheckpoints.folder],
          set: { cursorValue, updatedAt: new Date() },
        });
    });
  }

  async clearPositions(
    tx: TenantTx,
    orgId: string,
    accountId: number,
  ): Promise<void> {
    await tx
      .delete(mailSyncCheckpoints)
      .where(
        and(
          eq(mailSyncCheckpoints.orgId, orgId),
          eq(mailSyncCheckpoints.accountId, accountId),
        ),
      );
  }
}
