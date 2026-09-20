import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  supportTickets,
  supportTicketMessages,
  supportTicketDrafts,
  supportMacros,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { OrgFeaturesService } from "../../ai/core/services/org-features.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { redactSensitiveData } from "../../ai/core/redaction.util";
import { logger } from "../../../common/logger/logger.service";

const translationSchema = z.object({
  translatedText: z.string(),
  detectedSourceLanguage: z.string(),
});

const improveReplyOutputSchema = z.object({
  improved: z.string(),
  changes: z.array(z.string()).max(5),
});

@Injectable()
export class SupportAiTranslationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  private async isAvailable(orgId: string): Promise<boolean> {
    const flags = await this.orgFeatures.getFlags(orgId);
    return flags.supportAi;
  }

  private async getTicketOrThrow(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.orgId, orgId),
      ),
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return ticket;
  }

  async translateMessage(
    orgId: string,
    ticketId: number,
    messageId: number,
    targetLanguage: string,
    userId?: string,
  ) {
    const message = await runInTenantTransaction(
      this.db,
      async () => {
        if (!(await this.isAvailable(orgId))) return null;
        await this.getTicketOrThrow(orgId, ticketId);
        const found = await this.db.query.supportTicketMessages.findFirst({
          where: and(
            eq(supportTicketMessages.id, messageId),
            eq(supportTicketMessages.ticketId, ticketId),
          ),
          columns: { body: true },
        });
        if (!found) throw new NotFoundException("Message not found");
        return found;
      },
      { orgId },
    );
    if (!message) return null;
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "support.translate",
      tier: "fast",
      schema: translationSchema,
      charge: true,
      prompt: {
        system:
          "You translate support-ticket messages faithfully, preserving tone and meaning. Return only the translation and your best guess at the source language — never add commentary.",
        user: `Translate the following message into ${targetLanguage}:\n\n${redactSensitiveData(message.body)}`,
      },
    });
    if (!gatewayResult.ok) {
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({
          message: gatewayResult.message,
        });
      logger.error("support message translation failed", {
        orgId,
        ticketId,
        messageId,
        kind: gatewayResult.kind,
      });
      return null;
    }
    return gatewayResult.data;
  }

  async translateDraft(
    orgId: string,
    ticketId: number,
    language: string,
    content?: string,
    userId?: string,
    membershipId?: number | null,
  ) {
    const body = await runInTenantTransaction(
      this.db,
      async () => {
        if (!(await this.isAvailable(orgId))) return null;
        await this.getTicketOrThrow(orgId, ticketId);
        if (content) return content;
        if (!userId) return undefined;
        if (membershipId == null)
          throw new BadRequestException("Organization membership required");
        const draft = await this.db.query.supportTicketDrafts.findFirst({
          where: and(
            eq(supportTicketDrafts.orgId, orgId),
            eq(supportTicketDrafts.ticketId, ticketId),
            eq(supportTicketDrafts.userMembershipId, membershipId),
          ),
          columns: { body: true },
        });
        return draft?.body;
      },
      { orgId },
    );
    if (body === null) return null;
    if (!body) throw new BadRequestException("No content to translate");
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "support.translate",
      tier: "fast",
      schema: translationSchema,
      charge: true,
      prompt: {
        system:
          "You translate support-agent draft replies faithfully, preserving tone and meaning. Return only the translation and source language — never add commentary.",
        user: `Translate the following draft into ${language}:\n\n${redactSensitiveData(body)}`,
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
    return gatewayResult.data;
  }

  async improveReply(
    orgId: string,
    ticketId: number,
    content: string,
    userId?: string,
    macroId?: number,
  ) {
    const context = await runInTenantTransaction(
      this.db,
      async () => {
        if (!(await this.isAvailable(orgId))) return null;
        const found = await this.getTicketOrThrow(orgId, ticketId);
        if (!macroId) return { ticket: found, macroCtx: "" };
        const macro = await this.db.query.supportMacros.findFirst({
          where: and(
            eq(supportMacros.id, macroId),
            eq(supportMacros.orgId, orgId),
          ),
          columns: { title: true, body: true },
        });
        return {
          ticket: found,
          macroCtx: macro
            ? `\n\nMacro to incorporate: "${macro.title}"\n${macro.body}`
            : "",
        };
      },
      { orgId },
    );
    if (!context) return null;
    const { ticket, macroCtx } = context;
    const gatewayResult = await this.aiGateway.invokeStructured({
      actor: { orgId, userId: userId ?? null },
      feature: "support.reply",
      tier: "fast",
      schema: improveReplyOutputSchema,
      charge: true,
      prompt: {
        system:
          "You improve support-agent reply drafts. Make them clearer, more empathetic, and professional while preserving the agent's intent. Return the improved reply and a short list of what changed.",
        user: `Ticket: ${redactSensitiveData(ticket.title)}\n\nCurrent draft:\n${redactSensitiveData(content)}${macroCtx}`,
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
    return gatewayResult.data;
  }
}
