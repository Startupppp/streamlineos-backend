import { and, eq, inArray } from "drizzle-orm";
import { chatAttachments } from "../../db/schema";
import type { TenantTx } from "../../db/drizzle.types";
import type { SubjectFileKey } from "../storage/storage-key-catalog";
import { ERASURE_ID_PAGE } from "./gdpr-subject-erasure-paging";

export const CHAT_ATTACHMENT_TABLE = "public.chat_attachments";

/**
 * The subject's uploaded chat files — the last sink the file-key catalog cannot reach.
 *
 * `collectSubjectFileKeysWithLegalHold` attributes an object to a subject only through a
 * real foreign key to `public.users`. `chat_attachments` has none: it reaches the person
 * only through `chat_messages.sender_membership_id`, so the whole table was classified
 * org-scoped and `purgeFromManifest` skips org-scoped keys by design. The consequence was
 * that erasure redacted `chat_messages.content` to `[ERASED]` while the file name, the
 * public `file_url` and the object itself survived.
 *
 * Driven by the ids the `chat_messages` redaction returned rather than by its own read of
 * `chat_messages`: that update already matches exactly the rows this sink must follow —
 * every message the subject sent, soft-deleted ones included, since an erasure must sweep
 * a message the subject deleted as well as one they left standing.
 *
 * `DELETE … RETURNING` captures each key in the same statement that removes the row, so
 * there is no window in which the row is gone and the object is unnamed. The keys go onto
 * the purge manifest, which is drained after the transaction commits.
 *
 * Ids are spent one `ERASURE_ID_PAGE` at a time so a prolific subject does not build a
 * single statement with hundreds of thousands of bind parameters.
 */
export async function purgeSubjectChatAttachments(
  tx: TenantTx,
  subject: { orgId: string },
  subjectMessageIds: readonly number[],
): Promise<SubjectFileKey[]> {
  const keys: SubjectFileKey[] = [];

  for (let start = 0; start < subjectMessageIds.length; start += ERASURE_ID_PAGE) {
    const page = subjectMessageIds.slice(start, start + ERASURE_ID_PAGE);
    if (page.length === 0) continue;

    const removed = await tx
      .delete(chatAttachments)
      .where(
        and(
          eq(chatAttachments.orgId, subject.orgId),
          inArray(chatAttachments.messageId, page),
        ),
      )
      .returning({ fileKey: chatAttachments.fileKey });

    for (const row of removed)
      keys.push({
        key: row.fileKey,
        table: CHAT_ATTACHMENT_TABLE,
        column: "file_key",
        source: "user-fk",
        orgId: subject.orgId,
      });
  }

  return keys;
}
