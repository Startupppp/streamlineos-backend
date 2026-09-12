import { and, eq } from "drizzle-orm";
import { mailMessageMetadata, mailSyncCheckpoints } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";

/**
 * Drop everything this connection mirrored on its way out.
 *
 * `mail_message_metadata` holds subject lines, sender addresses and snippets of
 * the member's real mail, and `mail_sync_checkpoints` holds the provider
 * position that would resume a sync into it. Neither carries a foreign key to
 * `user_integration_connections` — `account_id` is a bare integer — so deleting
 * the connection row left both behind with nothing that would ever reach them
 * again: a revoked mailbox's contents kept indefinitely, and no purge path.
 * `MailMetadataService.markStaleForAccount` and
 * `MailSyncCheckpointService.clearPositions` exist for exactly this and had no
 * caller at all.
 *
 * Deleted rather than marked stale, because the connection is gone: a stale row
 * is one that will be refreshed, and this one never will be. It runs inside the
 * caller's transaction so the mirror cannot outlive the connection row through a
 * partial failure.
 *
 * Unconditional rather than gated on a gmail/outlook toolkit: `account_id` is
 * this table's own primary key, unique across every toolkit, so a non-mail
 * connection id matches no mirrored row. Reading the toolkit first would be a
 * second query to reach the same answer.
 */
export async function purgeMirroredMail(
  tx: TenantTx,
  orgId: string,
  connectionId: number,
): Promise<void> {
  await tx
    .delete(mailMessageMetadata)
    .where(
      and(
        eq(mailMessageMetadata.orgId, orgId),
        eq(mailMessageMetadata.accountId, connectionId),
      ),
    );
  await tx
    .delete(mailSyncCheckpoints)
    .where(
      and(
        eq(mailSyncCheckpoints.orgId, orgId),
        eq(mailSyncCheckpoints.accountId, connectionId),
      ),
    );
}
