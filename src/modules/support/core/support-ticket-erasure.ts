import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { supportTicketEmbeddings, supportTickets, users } from "../../../db/schema";
import type { TenantTx } from "../../../db/drizzle.types";

export const SUPPORT_ERASURE_PAGE = 200;
export const ERASED_REQUESTER_NAME = "ERASED";

export interface SupportSubjectErasureParams {
  orgId: string;
  subjectUserId: string;
}

export interface SupportSubjectErasureResult {
  ticketsAnonymised: number;
  embeddingsDeleted: number;
}

export function erasedRequesterEmail(subjectUserId: string): string {
  const hash = createHash("sha256").update(subjectUserId).digest("hex").slice(0, 16);
  return `erased-${hash}@erased.invalid`;
}

/**
 * Must run BEFORE the subject's `users.email` is anonymised: the requester columns
 * are free text with no FK to the subject, so the live address is the only link
 * back to the tickets they raised.
 */
export async function anonymiseSubjectSupportTickets(
  tx: TenantTx,
  params: SupportSubjectErasureParams,
): Promise<SupportSubjectErasureResult> {
  const result: SupportSubjectErasureResult = {
    ticketsAnonymised: 0,
    embeddingsDeleted: 0,
  };

  const [subject] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, params.subjectUserId))
    .limit(1);
  const subjectEmail = subject?.email?.trim().toLowerCase();
  if (!subjectEmail) return result;

  const erasedEmail = erasedRequesterEmail(params.subjectUserId);
  if (erasedEmail === subjectEmail) return result;

  let cursor: number | null = null;
  for (;;) {
    const page = await tx
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.orgId, params.orgId),
          sql`lower(${supportTickets.requesterEmail}) = ${subjectEmail}`,
          ...(cursor === null ? [] : [gt(supportTickets.id, cursor)]),
        ),
      )
      .orderBy(asc(supportTickets.id))
      .limit(SUPPORT_ERASURE_PAGE);
    if (page.length === 0) return result;

    const ticketIds = page.map((row) => row.id);

    const anonymised = await tx
      .update(supportTickets)
      .set({ requesterEmail: erasedEmail, requesterName: ERASED_REQUESTER_NAME })
      .where(
        and(
          eq(supportTickets.orgId, params.orgId),
          inArray(supportTickets.id, ticketIds),
        ),
      )
      .returning({ id: supportTickets.id });
    result.ticketsAnonymised += anonymised.length;

    const embeddings = await tx
      .delete(supportTicketEmbeddings)
      .where(
        and(
          eq(supportTicketEmbeddings.orgId, params.orgId),
          inArray(supportTicketEmbeddings.ticketId, ticketIds),
        ),
      )
      .returning({ id: supportTicketEmbeddings.id });
    result.embeddingsDeleted += embeddings.length;

    if (page.length < SUPPORT_ERASURE_PAGE) return result;
    const last = page[page.length - 1];
    if (!last || last.id === cursor) return result;
    cursor = last.id;
  }
}
