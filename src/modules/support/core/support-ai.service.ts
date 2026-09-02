import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  supportAiSuggestions,
  supportTicketLinks,
  supportTickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { SupportAiTriageService } from "./support-ai-triage.service";
import { SupportAiTriageAnalysisService } from "./support-ai-triage-analysis.service";
import { SupportAiTranslationService } from "./support-ai-translation.service";
import { SupportAiReportHelper, type AiReportFilters } from "./support-ai-report.helper";
import type { ResolveAiSuggestionInput } from "./dto/support.schemas";

@Injectable()
export class SupportAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly triage: SupportAiTriageService,
    private readonly analysis: SupportAiTriageAnalysisService,
    private readonly translation: SupportAiTranslationService,
    private readonly reportHelper: SupportAiReportHelper,
  ) {}

  analyzeTicket(orgId: string, ticketId: number) {
    return this.analysis.analyzeTicket(orgId, ticketId);
  }

  suggestReply(user: CurrentUserContext, ticketId: number) {
    return this.triage.suggestReply(user, ticketId);
  }

  suggestMacro(orgId: string, userId: string, ticketId: number, membershipId?: number | null) {
    return this.triage.suggestMacro(orgId, userId, ticketId, membershipId);
  }

  suggestKbArticles(user: CurrentUserContext, ticketId: number) {
    return this.triage.suggestKbArticles(user, ticketId);
  }

  findDuplicates(orgId: string, ticketId: number) {
    return this.analysis.findDuplicates(orgId, ticketId);
  }

  generateHandoffSummary(user: CurrentUserContext, ticketId: number) {
    return this.triage.generateHandoffSummary(user, ticketId);
  }

  findRootCauseCluster(orgId: string, ticketId: number, userId?: string) {
    return this.analysis.findRootCauseCluster(orgId, ticketId, userId);
  }

  translateMessage(orgId: string, ticketId: number, messageId: number, targetLanguage: string, userId?: string) {
    return this.translation.translateMessage(orgId, ticketId, messageId, targetLanguage, userId);
  }

  translateDraft(orgId: string, ticketId: number, language: string, content?: string, userId?: string, membershipId?: number | null) {
    return this.translation.translateDraft(orgId, ticketId, language, content, userId, membershipId);
  }

  improveReply(orgId: string, ticketId: number, content: string, userId?: string, macroId?: number) {
    return this.translation.improveReply(orgId, ticketId, content, userId, macroId);
  }

  getAiReport(orgId: string, filters: AiReportFilters) {
    return this.reportHelper.getAiReport(orgId, filters);
  }

  async runFullAnalysis(orgId: string, ticketId: number, _userId?: string): Promise<void> {
    await Promise.allSettled([
      this.analysis.analyzeTicket(orgId, ticketId),
      this.analysis.findDuplicates(orgId, ticketId),
    ]);
  }

  listSuggestions(orgId: string, ticketId: number) {
    return this.db.query.supportAiSuggestions.findMany({
      where: and(eq(supportAiSuggestions.orgId, orgId), eq(supportAiSuggestions.ticketId, ticketId)),
      orderBy: [desc(supportAiSuggestions.createdAt)],
      limit: 100,
    });
  }

  async resolveSuggestion(orgId: string, suggestionId: number, userId: string, input: ResolveAiSuggestionInput) {
    const suggestion = await this.db.query.supportAiSuggestions.findFirst({
      where: and(eq(supportAiSuggestions.id, suggestionId), eq(supportAiSuggestions.orgId, orgId)),
    });
    if (!suggestion) throw new NotFoundException("Suggestion not found");
    if (suggestion.status !== "pending") throw new ForbiddenException("Suggestion already resolved");
    if (input.status === "accepted") await this.applySuggestion(orgId, suggestion);
    const [updated] = await this.db
      .update(supportAiSuggestions)
      .set({ status: input.status, feedback: input.feedback ?? null, resolvedAt: new Date(), resolvedBy: userId })
      .where(and(eq(supportAiSuggestions.id, suggestionId), eq(supportAiSuggestions.orgId, orgId)))
      .returning();
    return updated;
  }

  private async applySuggestion(orgId: string, suggestion: typeof supportAiSuggestions.$inferSelect): Promise<void> {
    const payload = suggestion.payload;
    switch (suggestion.type) {
      case "priority": {
        const VALID_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
        type ValidPriority = (typeof VALID_PRIORITIES)[number];
        const raw = String(payload.priority ?? "");
        if (!VALID_PRIORITIES.includes(raw as ValidPriority)) return;
        await this.db.update(supportTickets)
          .set({ priority: raw as ValidPriority, updatedAt: new Date() })
          .where(and(eq(supportTickets.id, suggestion.ticketId), eq(supportTickets.orgId, orgId)));
        return;
      }
      case "category": {
        const category = String(payload.category ?? "");
        if (!category) return;
        await this.db.update(supportTickets)
          .set({ category, updatedAt: new Date() })
          .where(and(eq(supportTickets.id, suggestion.ticketId), eq(supportTickets.orgId, orgId)));
        return;
      }
      case "duplicate": {
        const candidateTicketId = Number(payload.candidateTicketId);
        if (!Number.isInteger(candidateTicketId) || candidateTicketId <= 0) return;
        await this.db.insert(supportTicketLinks)
          .values({ orgId, ticketId: suggestion.ticketId, linkedTicketId: candidateTicketId, relation: "duplicate", createdBy: null })
          .onConflictDoNothing();
        return;
      }
      default:
        return;
    }
  }
}
