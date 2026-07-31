import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { supportCsatRequests, supportTickets, csatSurveys, csatResponses } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
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
      .where(
        and(
          eq(supportCsatRequests.id, request.id),
          eq(supportCsatRequests.orgId, request.orgId),
          isNull(supportCsatRequests.respondedAt),
        ),
      )
      .returning();
    if (!updated) throw new ConflictException("This survey has already been submitted");
    return { success: true, score: updated.score };
  }

  /**
   * StreamlineOS has three independent CSAT-adjacent systems (a known "extend, don't
   * duplicate" miss): this per-ticket auto-CSAT flow, the generic campaign-style `csat`
   * module (client-scoped, no ticket linkage), and the general-purpose `surveys` module
   * (no ticket/client linkage, no normalized rating semantics). Rather than a risky data
   * migration onto one schema, this report surfaces all comparable sources side by side —
   * `sources.crmCampaigns` normalizes each survey's `rating/scaleMax` onto the same 1-5
   * scale as ticket CSAT so the two averages are actually comparable. The general `surveys`
   * module is deliberately excluded (see `sources.generalSurveys.reason`) rather than
   * silently blended in, since its `score` isn't a guaranteed satisfaction rating.
   */
  async getReport(orgId: string) {
    const rows = await this.db.query.supportCsatRequests.findMany({
      where: and(eq(supportCsatRequests.orgId, orgId)),
      columns: { score: true, respondedAt: true },
    });
    const responded = rows.filter((r) => r.score !== null);
    const average = responded.length > 0 ? responded.reduce((sum, r) => sum + (r.score ?? 0), 0) / responded.length : null;
    const ticketCsat = {
      totalRequests: rows.length,
      totalResponses: responded.length,
      responseRate: rows.length > 0 ? responded.length / rows.length : 0,
      averageScore: average,
    };

    const crmCampaigns = await this.getCrmCampaignCsat(orgId);

    return {
      ...ticketCsat,
      sources: {
        ticket: ticketCsat,
        crmCampaigns,
        generalSurveys: {
          excluded: true as const,
          reason:
            "Survey scores in the general surveys module aren't a normalized satisfaction rating (NPS/quiz/lead-qualification scoring varies per survey) and have no ticket or client linkage, so they can't be meaningfully compared here.",
        },
      },
    };
  }

  /** Client-scoped, not ticket-scoped — the generic csat module has no ticketId at all. */
  private async getCrmCampaignCsat(orgId: string) {
    const [surveys, responses] = await Promise.all([
      this.db.query.csatSurveys.findMany({
        where: eq(csatSurveys.orgId, orgId),
        columns: { id: true },
      }),
      this.db
        .select({ rating: csatResponses.rating, scaleMax: csatSurveys.scaleMax })
        .from(csatResponses)
        .innerJoin(csatSurveys, eq(csatSurveys.id, csatResponses.surveyId))
        .where(eq(csatResponses.orgId, orgId)),
    ]);

    if (surveys.length === 0) return null;
    if (responses.length === 0) {
      return { totalSurveys: surveys.length, totalResponses: 0, averageScore: null };
    }

    // Normalize each response onto the same 1-5 scale as ticket CSAT before averaging,
    // since scaleMax is configurable per survey (default 5, but not guaranteed).
    const normalized = responses.map((r) => (r.rating / r.scaleMax) * 5);
    const averageScore = normalized.reduce((sum, n) => sum + n, 0) / normalized.length;

    return { totalSurveys: surveys.length, totalResponses: responses.length, averageScore };
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
