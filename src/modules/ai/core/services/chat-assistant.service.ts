import { Inject, Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import { Redis } from "@upstash/redis";
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
import { REDIS } from "../../../../common/cache/cache.service";
import { AiConcurrencyLimiter } from "../gateway/ai-concurrency-limiter";
import { AiStreamBreaker } from "../streaming/ai-stream-breaker";

const MAX_HISTORY_MESSAGES = 40;
const MAX_OUTPUT_TOKENS = 4_096;
const CHAT_BREAKER_MESSAGE = "AI chat provider is temporarily unavailable";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

@Injectable()
export class ChatAssistantService {
  private readonly breaker: AiStreamBreaker;

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
    @Optional() @Inject(REDIS) private readonly redis: Redis | null = null,
    private readonly concurrencyLimiter: AiConcurrencyLimiter,
  ) {
    this.breaker = new AiStreamBreaker({
      key: "chat",
      unavailableMessage: CHAT_BREAKER_MESSAGE,
      redis: this.redis,
    });
  }

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
    signal?: AbortSignal,
  ) {
    const appOverheadStart = Date.now();
    const { userId, orgId } = actor;
    const membershipId = actingMembershipId(actor.principal) ?? 0;

    await this.breaker.assertClosed();

    const acquired = await this.concurrencyLimiter.acquire(orgId);
    if (!acquired)
      throw new ServiceUnavailableException("Too many concurrent AI requests for this organization");

    let concurrencyReleased = false;
    const releaseConcurrency = () => {
      if (concurrencyReleased) return;
      concurrencyReleased = true;
      this.concurrencyLimiter.release(orgId);
    };

    let reservationId = 0;
    try {
      const reserveMilli = getReserveEstimateMilli(CHAT_FEATURE);
      const reserved = await this.ledger.reserve({
        orgId,
        userId,
        feature: CHAT_FEATURE,
        credits: reserveMilli,
      });
      reservationId = reserved.reservationId;
    } catch (error) {
      releaseConcurrency();
      throw error;
    }

    let resolved = false;
    const releaseReservation = (reason: string) => {
      if (resolved) return;
      resolved = true;
      void this.ledger.release(reservationId, reason, orgId).catch(() => undefined);
    };

    try {
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

      const modelMessages: ModelMessage[] = messages.slice(-MAX_HISTORY_MESSAGES).map((m) =>
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

      const appOverheadMs = Date.now() - appOverheadStart;
      let ttftMs: number | undefined;
      let streamTextCallTime: number;

      const buildStream = () => {
        streamTextCallTime = Date.now();
        return streamText({
          model: resolveChatModel(),
          messages: modelMessages,
          system: contextPrompt,
          temperature: 0.7,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          maxRetries: resolveLlmRetryPolicy().maxRetriesPerModel,
          stopWhen: stepCountIs(10),
          ...(signal !== undefined ? { abortSignal: signal } : {}),
          onChunk: () => {
            if (ttftMs === undefined) ttftMs = Date.now() - streamTextCallTime;
          },
          onError: ({ error }) => {
            if (signal?.aborted === true || isAbortError(error)) return;
            this.breaker.recordFailure();
            logger.warn("AI chat stream failed", {
              error: error instanceof Error ? error.message : String(error),
              orgId,
            });
          },
          onFinish: async ({ text, usage }) => {
            if (resolved) return;
            resolved = true;
            releaseConcurrency();
            const promptTokens = usage?.inputTokens ?? 0;
            const completionTokens = usage?.outputTokens ?? 0;
            this.breaker.recordSuccess();
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
                  ttftMs,
                  appOverheadMs,
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
      };

      try {
        const stream = buildStream();
        void Promise.resolve(stream.finishReason).catch(() => {
          releaseConcurrency();
          releaseReservation("stream_aborted_no_settle");
        });
        return stream;
      } catch (error) {
        this.breaker.recordFailure();
        releaseConcurrency();
        releaseReservation("stream_setup_error");
        throw error;
      }
    } catch (error) {
      releaseConcurrency();
      releaseReservation("chat_setup_error");
      throw error;
    }
  }
}
