import { and, count, eq, inArray, like } from "drizzle-orm";
import { type DbWithClient } from "../common/tenant/tenant-db";
import { runInNewTenantTransaction } from "../common/tenant/run-in-tenant-transaction";
import { organizationMembers, users } from "../db/schema/common/auth";
import { helpdeskTickets } from "../db/schema/hr/attendance";
import { hrLegalHolds } from "../db/schema/hr/governance";
import { announcements } from "../db/schema/hr/announcements";
import { mailMessageMetadata } from "../db/schema/mail/mail-metadata";

export const ACCT = 88_888_888;
export const HD_BATCH = 200;
export const ago = (n: number) => new Date(Date.now() - n * 86_400_000);

export const cntTickets = (db: DbWithClient, o: string, uid: string) =>
  runInNewTenantTransaction(db, o, async () => {
    const [r] = await db
      .select({ c: count() })
      .from(helpdeskTickets)
      .where(
        and(eq(helpdeskTickets.orgId, o), eq(helpdeskTickets.userId, uid)),
      );
    return Number(r?.c ?? 0);
  });
export const cntMail = (db: DbWithClient, o: string, mid: number) =>
  runInNewTenantTransaction(db, o, async () => {
    const [r] = await db
      .select({ c: count() })
      .from(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, o),
          eq(mailMessageMetadata.userMembershipId, mid),
        ),
      );
    return Number(r?.c ?? 0);
  });
export const cntAnn = (db: DbWithClient, o: string, uid: string) =>
  runInNewTenantTransaction(db, o, async () => {
    const [r] = await db
      .select({ c: count() })
      .from(announcements)
      .where(and(eq(announcements.orgId, o), eq(announcements.authorId, uid)));
    return Number(r?.c ?? 0);
  });

export async function cleanup(
  db: DbWithClient,
  orgA: string,
  orgB: string,
  uids: string[],
  mids: number[],
  runId: string,
): Promise<void> {
  await runInNewTenantTransaction(db, orgA, async () => {
    if (mids.length)
      await db
        .delete(mailMessageMetadata)
        .where(
          and(
            eq(mailMessageMetadata.orgId, orgA),
            inArray(mailMessageMetadata.userMembershipId, mids),
          ),
        );
    await db
      .delete(mailMessageMetadata)
      .where(
        and(
          eq(mailMessageMetadata.orgId, orgA),
          like(mailMessageMetadata.messageId, `%${runId}`),
        ),
      );
    await db
      .delete(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgA),
          inArray(helpdeskTickets.userId, uids),
        ),
      );
    await db
      .delete(hrLegalHolds)
      .where(
        and(
          eq(hrLegalHolds.orgId, orgA),
          inArray(hrLegalHolds.subjectUserId, uids),
        ),
      );
    await db
      .delete(announcements)
      .where(
        and(
          eq(announcements.orgId, orgA),
          inArray(announcements.authorId, uids),
        ),
      );
    await db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgA),
          inArray(organizationMembers.userId, uids),
        ),
      );
  });
  await runInNewTenantTransaction(db, orgB, async () => {
    await db
      .delete(helpdeskTickets)
      .where(
        and(
          eq(helpdeskTickets.orgId, orgB),
          inArray(helpdeskTickets.userId, uids),
        ),
      );
  });
  await db.delete(users).where(inArray(users.id, uids));
}
