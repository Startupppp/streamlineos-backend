import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { supportCsatRequests, supportTickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { SubmitCsatInput } from "./dto/support.schemas";

@Injectable()
export class SupportCsatService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Idempotent per ticket — a ticket resolved more than once doesn't get more than one CSAT request. */
  async createRequestForTicket(orgId: string, ticketId: number): Promise<void> {
    await this.assertTicketInOrg(orgId, ticketId);
    const token = generateToken();
    await this.db
      .insert(supportCsatRequests)
      .values({ orgId, ticketId, token })
      .onConflictDoNothing({ target: supportCsatRequests.ticketId });
  }

  async getByToken(token: string) {
    const request = await this.db.query.supportCsatRequests.findFirst({
      where: eq(supportCsatRequests.token, token),
      with: { ticket: { columns: { id: true, title: true } } },
    });
    if (!request) throw new NotFoundException("Invalid or expired CSAT link");
    return { ticketId: request.ticket?.id, ticketTitle: request.ticket?.title, alreadyResponded: !!request.respondedAt };
  }

  async submit(token: string, input: SubmitCsatInput) {
    const request = await this.db.query.supportCsatRequests.findFirst({
      where: eq(supportCsatRequests.token, token),
    });
    if (!request) throw new NotFoundException("Invalid or expired CSAT link");
    if (request.respondedAt) throw new ConflictException("This survey has already been submitted");

    const [updated] = await this.db
      .update(supportCsatRequests)
      .set({ score: input.score, comment: input.comment ?? null, respondedAt: new Date() })
      .where(eq(supportCsatRequests.id, request.id))
      .returning();
    return { success: true, score: updated.score };
  }

  async getReport(orgId: string) {
    const rows = await this.db.query.supportCsatRequests.findMany({
      where: and(eq(supportCsatRequests.orgId, orgId)),
      columns: { score: true, respondedAt: true },
    });
    const responded = rows.filter((r) => r.score !== null);
    const average = responded.length > 0 ? responded.reduce((sum, r) => sum + (r.score ?? 0), 0) / responded.length : null;
    return {
      totalRequests: rows.length,
      totalResponses: responded.length,
      responseRate: rows.length > 0 ? responded.length / rows.length : 0,
      averageScore: average,
    };
  }

  private async assertTicketInOrg(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
