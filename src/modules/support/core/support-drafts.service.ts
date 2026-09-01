import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { supportTickets, supportTicketDrafts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { UpsertDraftInput } from "./dto/support.schemas";

@Injectable()
export class SupportDraftsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertTicketExists(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }

  async getDraft(orgId: string, ticketId: number, userId: string, membershipId: number | null) {
    await this.assertTicketExists(orgId, ticketId);
    const ownerPredicate = membershipId != null
      ? eq(supportTicketDrafts.userMembershipId, membershipId)
      : eq(supportTicketDrafts.userId, userId);
    const draft = await this.db.query.supportTicketDrafts.findFirst({
      where: and(eq(supportTicketDrafts.ticketId, ticketId), ownerPredicate),
    });
    return draft ?? null;
  }

  async upsertDraft(orgId: string, ticketId: number, userId: string, membershipId: number | null, input: UpsertDraftInput) {
    await this.assertTicketExists(orgId, ticketId);
    const [draft] = await this.db
      .insert(supportTicketDrafts)
      .values({ orgId, ticketId, userId, userMembershipId: membershipId ?? undefined, body: input.body, isInternal: input.isInternal })
      .onConflictDoUpdate({
        target: [supportTicketDrafts.ticketId, supportTicketDrafts.userId],
        set: { body: input.body, isInternal: input.isInternal, userMembershipId: membershipId ?? undefined, updatedAt: new Date() },
      })
      .returning();
    return draft;
  }

  async deleteDraft(orgId: string, ticketId: number, userId: string, membershipId: number | null) {
    await this.assertTicketExists(orgId, ticketId);
    const ownerPredicate = membershipId != null
      ? eq(supportTicketDrafts.userMembershipId, membershipId)
      : eq(supportTicketDrafts.userId, userId);
    await this.db
      .delete(supportTicketDrafts)
      .where(and(eq(supportTicketDrafts.ticketId, ticketId), ownerPredicate));
    return { success: true };
  }
}
