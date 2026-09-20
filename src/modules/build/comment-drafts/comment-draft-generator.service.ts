import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { tickets, ticketComments } from "../../../db/schema/build/tasks";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { logger } from "../../../common/logger/logger.service";
import { CommentDraftsService } from "./comment-drafts.service";
import { generatedDraftAiOutputSchema } from "./dto/comment-drafts.schemas";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";

const FEATURE_KEY = "ticket.generate-comment-draft";
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_COMMENT_CHARS = 500;
const COMMENT_LIMIT = 5;
const MAX_OUTPUT_TOKENS = 512;

const SYSTEM_PROMPT =
  "You are a project management assistant. Given a ticket's details and recent comments, write a concise comment draft proposing a concrete next step or resolution. Return JSON with: body (the comment text, required), evidence (what in the ticket led to this suggestion, or null), proposedChange (the suggested action in one sentence, or null), impact (who or what is affected, or null), confidence (integer 0-100 indicating certainty), affectedRecordIds (array of ticket id numbers affected, or null).";

@Injectable()
export class CommentDraftGeneratorService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly drafts: CommentDraftsService,
  ) {}

  async generate(
    orgId: string,
    membershipId: number | null,
    userId: string,
    ticketId: number,
  ): Promise<
    Awaited<ReturnType<CommentDraftsService["upsertGenerated"]>> & {
      aiUsage: AiUsageMeta;
    }
  > {
    if (membershipId === null)
      throw new ForbiddenException("Organization membership required");

    const [ticketRow, commentRows] = await Promise.all([
      this.db
        .select({
          id: tickets.id,
          title: tickets.title,
          description: tickets.description,
          status: tickets.status,
          priority: tickets.priority,
          type: tickets.type,
        })
        .from(tickets)
        .where(
          and(
            eq(tickets.id, ticketId),
            eq(tickets.orgId, orgId),
            isNull(tickets.deletedAt),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      this.db
        .select({ content: ticketComments.content })
        .from(ticketComments)
        .where(
          and(
            eq(ticketComments.ticketId, ticketId),
            eq(ticketComments.orgId, orgId),
            isNull(ticketComments.deletedAt),
          ),
        )
        .orderBy(desc(ticketComments.createdAt))
        .limit(COMMENT_LIMIT),
    ]);

    if (!ticketRow) throw new NotFoundException("Ticket not found");

    const description = ticketRow.description?.trim() ?? "";
    if (description.length === 0 && commentRows.length === 0)
      throw new UnprocessableEntityException(
        "This ticket has no description or comments to draft from",
      );

    const commentSection = commentRows
      .map((c, i) => `Comment ${i + 1}: ${c.content.slice(0, MAX_COMMENT_CHARS)}`)
      .join("\n");

    const userPrompt =
      `Ticket #${ticketRow.id} — ${ticketRow.title}\n` +
      `Type: ${ticketRow.type} | Status: ${ticketRow.status} | Priority: ${ticketRow.priority}\n\n` +
      `Description:\n${description.slice(0, MAX_DESCRIPTION_CHARS)}\n\n` +
      `Recent comments:\n${commentSection}`;

    const result = await this.aiGateway.invokeStructuredWithUsage({
      actor: { orgId, userId },
      feature: FEATURE_KEY,
      tier: "fast",
      charge: true,
      maxTokens: MAX_OUTPUT_TOKENS,
      schema: generatedDraftAiOutputSchema,
      prompt: { system: SYSTEM_PROMPT, user: userPrompt },
    });

    if (!result.ok) {
      if (result.kind === "quota_exceeded") {
        throw new InsufficientAiCreditsException({ message: result.message });
      }
      logger.error("comment draft generation failed", {
        orgId,
        ticketId,
        kind: result.kind,
        message: result.message,
      });
      throw new Error("AI draft generation failed");
    }

    const draft = await this.drafts.upsertGenerated(
      orgId,
      membershipId,
      ticketId,
      result.data,
    );

    return { ...draft, aiUsage: result.aiUsage };
  }
}
