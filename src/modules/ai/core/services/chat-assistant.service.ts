import { Inject, Injectable } from "@nestjs/common";
import { getPersona } from "../persona-registry";
import { stepCountIs, type ModelMessage } from "ai";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../../common/tenant/run-in-tenant-transaction";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import { AccessService } from "../../../access/access.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { ChatHistoryService } from "./chat-history.service";
import {
  ASK_OS_TOOL_PROVIDERS,
  collectToolDefinitions,
} from "../registry/ask-os-tool-providers";
import { buildAskOsToolset } from "../registry/ask-os-tool-registry";
import type { AskOsToolProvider } from "../registry/ask-os-tool.types";
import {
  CHAT_FEATURE,
  resolveChatModel,
  resolveChatModelId,
  type ChatMessage,
} from "./chat-assistant-model";
import { buildContextPrompt } from "./chat-assistant-prompt";
import { fetchChatContext, type ChatTurnContext } from "./chat-assistant-context";
import { makeAskOsDirectivePipe, type PipeableAiUiStream } from "../streaming/ai-stream-response";
import type { AskOsDirective } from "../streaming/ask-os-directive";

const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 24_000;
const MAX_OUTPUT_TOKENS = 2_048;
const CHAT_BREAKER_KEY = "chat";
const MAX_TOOL_STEPS = 10;

function boundedChatHistory(messages: ChatMessage[]): ModelMessage[] {
  const selected: ModelMessage[] = [];
  let remaining = MAX_HISTORY_CHARS;

  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < MAX_HISTORY_MESSAGES;
    index -= 1
  ) {
    const message = messages[index];
    if (!message || remaining === 0) break;
    const content = message.content.slice(0, remaining);
    remaining -= content.length;
    selected.push({ role: message.role, content });
  }

  return selected.reverse();
}

@Injectable()
export class ChatAssistantService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly history: ChatHistoryService,
    private readonly access: AccessService,
    @Inject(ASK_OS_TOOL_PROVIDERS)
    private readonly toolProviders: readonly AskOsToolProvider[],
  ) {}

  private async fetchContext(
    userId: string,
    orgId: string,
    caller: CurrentUserContext,
  ): Promise<ChatTurnContext> {
    return fetchChatContext(this.db, userId, orgId, caller);
  }

  private async appendTurn(
    orgId: string,
    userId: string,
    membershipId: number,
    conversationId: number | undefined,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    if (conversationId !== undefined) {
      await this.history.appendToConversation(
        orgId,
        userId,
        membershipId,
        conversationId,
        role,
        content,
      );
      return;
    }
    await this.history.append(orgId, userId, membershipId, role, content);
  }

  async processChat(
    messages: ChatMessage[],
    actor: CurrentUserContext,
    conversationId?: number,
    persona?: string,
    signal?: AbortSignal,
  ): Promise<PipeableAiUiStream> {
    const { userId, orgId } = actor;
    const membershipId = actingMembershipId(actor.principal) ?? 0;

    // The handler is `@NoTenantTransaction()` (chat-assistant.controller.ts), so
    // `TenantContextInterceptor` never opens one and the DRIZZLE proxy falls
    // through to the bare pool with no `app.organization_id`. Every table read
    // here is RLS-protected and `app.current_org_id()` RAISES 42501 rather than
    // returning NULL, so without this wrapper the context read and the
    // user-message append both fail and the whole route answers 500 for every
    // tenant. Passing `orgId` explicitly is what makes this open its own
    // transaction under that decorator.
    //
    // It must NOT span the stream: holding a pooled connection
    // idle-in-transaction across a provider round trip is the thing
    // `@NoTenantTransaction()` exists to prevent (PRD-C078). The context reads
    // stay inside `fetchChatContext`'s single `Promise.all` so postgres.js
    // pipelines them onto the one connection this transaction holds.
    const turn = await runInTenantTransaction(
      this.db,
      async (): Promise<ChatTurnContext> => {
        const loaded = await this.fetchContext(userId, orgId, actor);
        const latest = messages.at(-1);
        if (latest?.role === "user") {
          await this.appendTurn(
            orgId,
            userId,
            membershipId,
            conversationId,
            "user",
            latest.content,
          );
        }
        return loaded;
      },
      { orgId },
    );

    const snapshot = await this.access.getAccessSnapshot(orgId, userId, actor);

    const basePrompt = buildContextPrompt(turn.context, turn.actor);
    const personaConfig = persona ? getPersona(persona) : undefined;
    const contextPrompt = personaConfig
      ? `${personaConfig.preamble}\n\n${basePrompt}`
      : basePrompt;

    const directives: AskOsDirective[] = [];

    const effectiveTools = buildAskOsToolset({
      db: this.db,
      actor: turn.actor,
      caller: actor,
      snapshot,
      definitions: collectToolDefinitions(this.toolProviders),
      onDirective: (d) => { directives.push(d); },
    });

    const result = await this.gateway.streamAgenticTurn({
      actor: { orgId, userId },
      feature: CHAT_FEATURE,
      breakerKey: CHAT_BREAKER_KEY,
      prompt: { system: contextPrompt, user: "" },
      messages: boundedChatHistory(messages),
      tools: effectiveTools,
      stopWhen: stepCountIs(MAX_TOOL_STEPS),
      temperature: 0.7,
      maxTokens: MAX_OUTPUT_TOKENS,
      model: resolveChatModel(),
      modelId: resolveChatModelId(),
      redact: false,
      charge: true,
      ...(signal !== undefined ? { signal } : {}),
      onCompleted: async ({ text }) => {
        await runInNewTenantTransaction(this.db, orgId, async () => {
          await this.appendTurn(
            orgId,
            userId,
            membershipId,
            conversationId,
            "assistant",
            text,
          );
        });
      },
    });

    return makeAskOsDirectivePipe(result.stream, directives);
  }
}
