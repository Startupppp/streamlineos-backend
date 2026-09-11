import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { and, eq, or, sql } from "drizzle-orm";
import { supportMacros, supportTicketMessages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { redactSensitiveData } from "../../ai/core/redaction.util";
import { logger } from "../../../common/logger/logger.service";
import { SupportAiSettingsService } from "./support-ai-settings.service";
import { SupportAiTriageDataService } from "./support-ai-triage-data.service";
import { macroPickSchema, handoffSummarySchema } from "./support-ai-triage.schemas";

@Injectable()
export class SupportAiTriageService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly data: SupportAiTriageDataService,
    private readonly aiGateway: AiGatewayService,
    private readonly aiSettings: SupportAiSettingsService,
  ) {}

  async suggestReply(user: CurrentUserContext, ticketId: number) {
    if (!(await this.data.isAvailable(user.orgId))) return null;
    const ticket = await this.data.getTicketOrThrow(user.orgId, ticketId);
    const [messages, sources, confidence, { confidenceThreshold }] =
      await Promise.all([
        this.db.query.supportTicketMessages.findMany({
          where: and(
            eq(supportTicketMessages.ticketId, ticketId),
            eq(supportTicketMessages.isInternal, false),
          ),
          orderBy: [supportTicketMessages.createdAt],
          limit: 20,
          columns: { body: true, authorId: true },
        }),
        this.data.searchKbForTicket(
          user,
          redactSensitiveData(
            `${ticket.title}\n${ticket.description ?? ""}`.trim(),
          ),
        ),
        this.data.getTicketConfidence(user.orgId, ticketId),
        this.aiSettings.getSettings(user.orgId),
      ]);
    const thread = messages
      .map(
        (m) =>
          `${m.authorId ? "Agent" : "Customer"}: ${redactSensitiveData(m.body)}`,
      )
      .join("\n\n");
    const kbCtx =
      sources.length > 0
        ? `\n\nRelevant KB articles:\n${sources.map((s) => `- ${s.title} (${s.url})`).join("\n")}`
        : "";
    const gatewayResult = await this.aiGateway.invokeText({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "support.reply",
      tier: "fast",
      maxTokens: 1024,
      charge: true,
      prompt: {
        system:
          "You draft support-agent replies. Write a helpful, concise, professional reply the agent can review and edit before sending. Never claim to have taken an action that hasn't happened.",
        user: `Ticket: ${redactSensitiveData(ticket.title)}\n\nConversation:\n${thread || redactSensitiveData(ticket.description ?? "") || "(no messages yet)"}${kbCtx}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({
          message: gatewayResult.message,
        });
      throw new ServiceUnavailableException(
        "AI assistant is temporarily unavailable",
      );
    }
    await this.data.replacePendingSuggestions(user.orgId, ticketId, ["reply"]);
    return this.data.insertSuggestion(
      user.orgId,
      ticketId,
      "reply",
      {
        body: gatewayResult.data.trim(),
        sources,
        escalated: confidence < confidenceThreshold,
      },
      null,
    );
  }

  async suggestMacro(
    orgId: string,
    userId: string,
    ticketId: number,
    membershipId?: number | null,
  ) {
    if (!(await this.data.isAvailable(orgId))) return null;
    if (membershipId == null)
      throw new ForbiddenException("Organization membership required");
    const ticket = await this.data.getTicketOrThrow(orgId, ticketId);
    const macros = await this.db.query.supportMacros.findMany({
      where: and(
        eq(supportMacros.orgId, orgId),
        or(
          sql`${supportMacros.visibility} != 'private'`,
          eq(supportMacros.createdByMembershipId, membershipId),
        ) ?? sql`false`,
      ),
      columns: { id: true, title: true, body: true },
      limit: 100,
    });
    if (macros.length === 0) return null;
    const catalog = macros
      .map(
        (m) =>
          `#${m.id}: ${m.title} — ${redactSensitiveData(m.body.slice(0, 200))}`,
      )
      .join("\n");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId },
      feature: "support.macro",
      tier: "fast",
      schema: macroPickSchema,
      charge: true,
      prompt: {
        system:
          "Pick the single macro (canned response) that best fits replying to this ticket. If none are a good fit, return null.",
        user: `Ticket: ${redactSensitiveData(ticket.title)}\n${redactSensitiveData(ticket.description ?? "")}\n\nAvailable macros:\n${catalog}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({
          message: gatewayResult.message,
        });
      logger.error("support suggest-macro failed", {
        orgId,
        ticketId,
        kind: gatewayResult.kind,
      });
      return null;
    }
    const result = gatewayResult.data;
    if (result.macroId === null || !macros.some((m) => m.id === result.macroId))
      return null;
    await this.data.replacePendingSuggestions(orgId, ticketId, ["macro"]);
    return this.data.insertSuggestion(
      orgId,
      ticketId,
      "macro",
      { macroId: result.macroId, reason: result.reason },
      result.confidence,
    );
  }

  async suggestKbArticles(user: CurrentUserContext, ticketId: number) {
    const ticket = await this.data.getTicketOrThrow(user.orgId, ticketId);
    if (!this.data.isEmbeddingsConfigured()) return null;
    if (!(await this.data.isAvailable(user.orgId))) return null;
    const articles = await this.data.searchKbForTicket(
      user,
      redactSensitiveData(
        `${ticket.title}\n${ticket.description ?? ""}`.trim(),
      ),
    );
    if (articles.length === 0) return null;
    await this.data.replacePendingSuggestions(user.orgId, ticketId, ["kb_article"]);
    return this.data.insertSuggestion(
      user.orgId,
      ticketId,
      "kb_article",
      { articles },
      null,
    );
  }

  async generateHandoffSummary(user: CurrentUserContext, ticketId: number) {
    if (!(await this.data.isAvailable(user.orgId))) return null;
    const ticket = await this.data.getTicketOrThrow(user.orgId, ticketId);
    const [messages, sources] = await Promise.all([
      this.db.query.supportTicketMessages.findMany({
        where: eq(supportTicketMessages.ticketId, ticketId),
        orderBy: [supportTicketMessages.createdAt],
        limit: 40,
        columns: { body: true, isInternal: true, authorId: true },
      }),
      this.data.searchKbForTicket(
        user,
        redactSensitiveData(
          `${ticket.title}\n${ticket.description ?? ""}`.trim(),
        ),
      ),
    ]);
    const thread = messages
      .map(
        (m) =>
          `${m.isInternal ? "Internal note" : m.authorId ? "Agent" : "Customer"}: ${redactSensitiveData(m.body)}`,
      )
      .join("\n\n");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId: user.orgId, userId: user.userId },
      feature: "support.handoff",
      tier: "fast",
      schema: handoffSummarySchema,
      charge: true,
      prompt: {
        system:
          "You brief a support agent who is picking up a ticket from a teammate. Be concrete about what's already been tried and what's still unresolved. Never invent facts not present below.",
        user: `Ticket: ${redactSensitiveData(ticket.title)}\nStatus: ${ticket.status}\nPriority: ${ticket.priority}\n\nFull history (including internal notes):\n${thread || "(no messages yet)"}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({
          message: gatewayResult.message,
        });
      logger.error("support handoff summary failed", {
        orgId: user.orgId,
        ticketId,
        kind: gatewayResult.kind,
      });
      return null;
    }
    await this.data.replacePendingSuggestions(user.orgId, ticketId, [
      "handoff_summary",
    ]);
    return this.data.insertSuggestion(
      user.orgId,
      ticketId,
      "handoff_summary",
      { ...gatewayResult.data, sources },
      null,
    );
  }
}
