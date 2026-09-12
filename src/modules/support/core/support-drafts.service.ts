import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { supportTicketDrafts } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { UpsertDraftInput } from "./dto/support.schemas";
import type { ScopedRead } from "../../access/scoped-read";
import { assertTicketInScope } from "./support-tickets-scope";

@Injectable()
export class SupportDraftsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getDraft(orgId: string, ticketId: number, _userId: string, membershipId: number | null, read: ScopedRead) {
    await assertTicketInScope(this.db, read, ticketId);
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    const draft = await this.db.query.supportTicketDrafts.findFirst({
      where: and(
        eq(supportTicketDrafts.orgId, orgId),
        eq(supportTicketDrafts.ticketId, ticketId),
        eq(supportTicketDrafts.userMembershipId, membershipId),
      ),
    });
    return draft ?? null;
  }

  async upsertDraft(orgId: string, ticketId: number, _userId: string, membershipId: number | null, input: UpsertDraftInput, read: ScopedRead) {
    await assertTicketInScope(this.db, read, ticketId);
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    const [draft] = await this.db
      .insert(supportTicketDrafts)
      .values({ orgId, ticketId, userMembershipId: membershipId, body: input.body, isInternal: input.isInternal })
      .onConflictDoUpdate({
        target: [supportTicketDrafts.ticketId, supportTicketDrafts.userMembershipId],
        set: { body: input.body, isInternal: input.isInternal, updatedAt: new Date() },
      })
      .returning();
    return draft;
  }

  async deleteDraft(orgId: string, ticketId: number, _userId: string, membershipId: number | null, read: ScopedRead) {
    await assertTicketInScope(this.db, read, ticketId);
    if (membershipId === null) throw new ForbiddenException("Organization membership required");
    await this.db
      .delete(supportTicketDrafts)
      .where(
        and(
          eq(supportTicketDrafts.orgId, orgId),
          eq(supportTicketDrafts.ticketId, ticketId),
          eq(supportTicketDrafts.userMembershipId, membershipId),
        ),
      );
    return { success: true };
  }
}
