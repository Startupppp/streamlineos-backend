import { Inject, Injectable } from "@nestjs/common";
import { filterToolsByPersona, getPersona } from "../persona-registry";
import { ModuleRef } from "@nestjs/core";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { resolveLlmRetryPolicy } from "../providers/llm-retry";
import { withTenantScopedTools } from "../tenant-scoped-tools";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import {
  AI_CREDIT_LEDGER,
  type AiCreditLedger,
} from "../gateway/credit-ledger.interface";
import { getReserveEstimateMilli } from "../billing/ai-cost-catalog";
import { settleStream } from "../gateway/ai-gateway-credit.helper";
import { AiUsageService } from "./ai-usage.service";
import { ProjectsAiService } from "./projects-ai.service";
import { ChatHistoryService } from "./chat-history.service";
import { HrCopilotTools } from "../hr-copilot-tools";
import { WorkspaceCopilotTools } from "../workspace-copilot-tools";
import { OpsCopilotTools } from "../ops-copilot-tools";
import { CrmCopilotTools } from "../crm-copilot-tools";
import { CommsCopilotTools } from "../comms-copilot-tools";
import { ProjectsCopilotTools } from "../projects-copilot-tools";
import { CommsActionsTools } from "../comms-actions-tools";
import { MailCopilotTools } from "../mail-copilot-tools";
import { ToolAccessService } from "../tool-access.service";
import {
  CHAT_FEATURE,
  resolveChatModel,
  resolveChatModelId,
  type ChatContext,
  type ChatMessage,
} from "./chat-assistant-model";
import { buildContextPrompt } from "./chat-assistant-prompt";
import { fetchChatContext } from "./chat-assistant-context";
import { buildInlineTools } from "./chat-assistant-inline-tools";

@Injectable()
export class ChatAssistantService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly projectsAi: ProjectsAiService,
    private readonly history: ChatHistoryService,
    private readonly hrCopilot: HrCopilotTools,
    private readonly workspaceCopilot: WorkspaceCopilotTools,
    private readonly opsCopilot: OpsCopilotTools,
    private readonly crmCopilot: CrmCopilotTools,
    private readonly commsCopilot: CommsCopilotTools,
    private readonly projectsCopilot: ProjectsCopilotTools,
    private readonly commsActions: CommsActionsTools,
    private readonly mailCopilot: MailCopilotTools,
    private readonly toolAccess: ToolAccessService,
    private readonly moduleRef: ModuleRef,
    private readonly usageSvc: AiUsageService,
    @Inject(AI_CREDIT_LEDGER) private readonly ledger: AiCreditLedger,
  ) {}

  private async fetchContext(
    userId: string,
    orgId: string,
  ): Promise<ChatContext> {
    return fetchChatContext(this.db, userId, orgId);
  }

  async processChat(
    messages: ChatMessage[],
    actor: CurrentUserContext,
    conversationId?: number,
    persona?: string,
  ) {
    const { userId, orgId } = actor;
    const membershipId = actingMembershipId(actor.principal) ?? 0;

    const reserveMilli = getReserveEstimateMilli(CHAT_FEATURE);
    const reserved = await this.ledger.reserve({
      orgId,
      userId,
      feature: CHAT_FEATURE,
      credits: reserveMilli,
    });
    const reservationId = reserved.reservationId;

    const context = await this.fetchContext(userId, orgId);
    const basePrompt = buildContextPrompt(context);
    const personaConfig = persona ? getPersona(persona) : undefined;
    const contextPrompt = personaConfig
      ? `${personaConfig.preamble}\n\n${basePrompt}`
      : basePrompt;

    const latest = messages.at(-1);
    if (latest?.role === "user") {
      if (conversationId !== undefined) {
        await this.history.appendToConversation(
          orgId,
          userId,
          membershipId,
          conversationId,
          "user",
          latest.content,
        );
      } else {
        await this.history.append(orgId, userId, membershipId, "user", latest.content);
      }
    }

    const modelMessages: ModelMessage[] = messages.map((m) =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: m.content },
    );

    const modelId = resolveChatModelId();

    const inlineTools = buildInlineTools({
      db: this.db,
      orgId,
      userId,
      actor,
      toolAccess: this.toolAccess,
      projectsAi: this.projectsAi,
      moduleRef: this.moduleRef,
    });

    const allBuiltTools = {
      ...this.hrCopilot.buildTools({ orgId, userId }),
      ...this.workspaceCopilot.buildTools({ actor }),
      ...this.opsCopilot.buildTools({ actor }),
      ...this.crmCopilot.buildTools({ actor }),
      ...this.commsCopilot.buildTools({ actor }),
      ...this.projectsCopilot.buildTools({ actor }),
      ...this.commsActions.buildTools({ actor }),
      ...this.mailCopilot.buildTools({ actor }),
      ...inlineTools,
    };

    const effectiveTools = withTenantScopedTools(
      persona ? filterToolsByPersona(allBuiltTools, persona) : allBuiltTools,
      this.db,
      orgId,
    );

    const buildStream = () =>
      streamText({
        model: resolveChatModel(),
        messages: modelMessages,
        system: contextPrompt,
        temperature: 0.7,
        maxRetries: resolveLlmRetryPolicy().maxRetriesPerModel,
        stopWhen: stepCountIs(10),
        onFinish: async ({ text, usage }) => {
          const promptTokens = usage?.inputTokens ?? 0;
          const completionTokens = usage?.outputTokens ?? 0;
          try {
            await runInNewTenantTransaction(this.db, orgId, async () => {
              await settleStream(this.ledger, this.usageSvc, {
                reservationId,
                model: modelId,
                promptTokens,
                completionTokens,
                orgId,
                userId,
                feature: CHAT_FEATURE,
              });
              if (conversationId !== undefined) {
                await this.history.appendToConversation(
                  orgId,
                  userId,
                  membershipId,
                  conversationId,
                  "assistant",
                  text,
                );
              } else {
                await this.history.append(orgId, userId, membershipId, "assistant", text);
              }
            });
          } catch (error) {
            logger.error("Failed to finalise assistant chat turn", {
              error:
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
              orgId,
              reservationId,
            });
          }
        },
        tools: effectiveTools,
      });

    try {
      return buildStream();
    } catch (error) {
      void this.ledger
        .release(reservationId, "stream_setup_error", orgId)
        .catch(() => undefined);
      throw error;
    }
  }
}
