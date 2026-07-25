import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, asc } from "drizzle-orm";
import { supportTickets, supportTicketMessages, kbArticles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AiGatewayService } from "../ai/gateway/ai-gateway.service";
import { throwOnAiFailure } from "../ai/services/gateway-result.util";
import { KbEventsService } from "./kb-events.service";
import { KbArticlesService } from "./kb-articles.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { kbFromTicketDraftSchema } from "./dto/kb-from-ticket.schemas";
import type { FromTicketInput } from "./dto/kb-from-ticket.schemas";

@Injectable()
export class KbFromTicketService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly events: KbEventsService,
    private readonly articles: KbArticlesService,
  ) {}

  async draftFromTicket(
    user: CurrentUserContext,
    ticketId: number,
    input: FromTicketInput,
  ): Promise<typeof kbArticles.$inferSelect> {
    const orgId = user.orgId;

    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const messages = await this.db
      .select()
      .from(supportTicketMessages)
      .where(eq(supportTicketMessages.ticketId, ticketId))
      .orderBy(asc(supportTicketMessages.createdAt));

    const ticketContent = [
      `Subject: ${ticket.title}`,
      ticket.description ? `Description: ${ticket.description}` : null,
      messages.length > 0
        ? `Messages:\n${messages.map((m) => `- ${m.body}`).join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await this.gateway.invokeStructuredWithUsage({
      actor: { orgId, userId: user.userId },
      feature: "kb.article-from-ticket",
      tier: "fast",
      maxTokens: 1024,
      charge: true,
      schema: kbFromTicketDraftSchema,
      prompt: {
        system:
          "You are a technical writer. From the support ticket below, write a clear, reusable knowledge base article in Markdown: a short problem statement, then the resolution as numbered steps. Return JSON {\"title\": string, \"content\": string}.",
        user: ticketContent,
      },
    });
    if (!result.ok) return throwOnAiFailure(result);
    const draft = result.data;

    const contentText = draft.content.replace(/[#*_`[\]()]/g, "").slice(0, 500);

    const article = await this.articles.create(user, {
      spaceId: input.spaceId,
      title: draft.title,
      content: draft.content,
      contentText,
      status: "draft",
      visibility: "internal",
    });

    await this.events.record(orgId, "ticket_deflected", {
      actorId: user.userId,
      articleId: article.id,
      metadata: { feature: "article_from_ticket", ticketId },
    });

    return article;
  }
}
