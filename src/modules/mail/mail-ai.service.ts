import { Injectable } from "@nestjs/common";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { throwOnAiFailure, unwrapAiResult } from "../ai/core/services/gateway-result.util";
import { MailService } from "./mail.service";
import {
  MailDraftOutputSchema,
  MailInboxSummaryOutputSchema,
  MailThreadSummaryOutputSchema,
  type MailDraftOutput,
  type MailInboxSummaryOutput,
  type MailThreadSummaryOutput,
} from "./dto/mail-ai-schemas";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AiUsageMeta } from "../ai/core/gateway/ai-gateway.types";

const SNIPPET_MAX = 160;
const BODY_CHAR_MAX = 1500;
const THREAD_MSG_MAX = 10;
const INBOX_MSG_MAX = 25;

function stripHtml(html: string | null): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

@Injectable()
export class MailAiService {
  constructor(
    private readonly mail: MailService,
    private readonly gateway: AiGatewayService,
  ) {}

  async inboxSummary(
    actor: CurrentUserContext,
    accountId?: number | "all",
  ): Promise<MailInboxSummaryOutput & { aiUsage?: AiUsageMeta }> {
    const accountIdParam = accountId === undefined || accountId === "all" ? "all" : String(accountId);

    const listResult = await this.mail.listMessages(
      actor.orgId,
      actor.userId,
      "inbox",
      accountIdParam,
      INBOX_MSG_MAX,
    );

    if (listResult.messages.length === 0) {
      return { summary: "Your inbox is empty.", highlights: [], actionItems: [] };
    }

    const lines = listResult.messages.map((m) => {
      const snippet = m.snippet.slice(0, SNIPPET_MAX);
      return `- From: ${m.from.email} | Subject: ${m.subject} | Read: ${m.isRead} | Snippet: ${snippet}`;
    });

    const system =
      "You are an intelligent email assistant. Given a list of inbox message metadata, produce a concise inbox summary, highlight the most important messages, and list any action items the user should handle. Output only valid JSON matching the requested schema. bodyHtml must use only p, br, ul, li tags.";
    const user = `Inbox messages (${listResult.messages.length} total):\n${lines.join("\n")}\n\nSummarize the inbox, identify highlights, and list action items.`;

    const result = await this.gateway.invokeStructuredWithUsage({
      actor: { orgId: actor.orgId, userId: actor.userId },
      feature: "mail.inbox-summary",
      prompt: { system, user },
      tier: "fast",
      schema: MailInboxSummaryOutputSchema,
      charge: true,
    });

    if (!result.ok) return throwOnAiFailure(result);
    return { ...result.data, aiUsage: result.aiUsage };
  }

  async threadSummary(
    actor: CurrentUserContext,
    accountId: number,
    threadId: string,
  ): Promise<MailThreadSummaryOutput> {
    const messages = await this.mail.getThread(actor.orgId, actor.userId, threadId, accountId);

    if (messages.length === 0) {
      return { summary: "This thread has no messages.", actionItems: [], suggestedReply: "" };
    }

    const capped = messages.slice(0, THREAD_MSG_MAX);
    const lines = capped.map((m) => {
      const text = stripHtml(m.bodyHtml ?? m.bodyText ?? "").slice(0, BODY_CHAR_MAX);
      return `From: ${m.from.email}\nSubject: ${m.subject}\nDate: ${m.date}\n${text}`;
    });

    const system =
      "You are an intelligent email assistant. Given a thread of email messages (oldest to newest), produce a concise summary, list action items, and suggest a short reply. Output only valid JSON matching the requested schema.";
    const user = `Email thread (${capped.length} message${capped.length > 1 ? "s" : ""}):\n\n${lines.join("\n\n---\n\n")}\n\nSummarize the thread, list action items, and suggest a reply.`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId: actor.orgId, userId: actor.userId },
      feature: "mail.thread-summary",
      prompt: { system, user },
      tier: "fast",
      schema: MailThreadSummaryOutputSchema,
      charge: true,
    });

    return unwrapAiResult(result);
  }

  async draft(
    actor: CurrentUserContext,
    input: {
      mode: "compose" | "reply";
      instruction: string;
      accountId?: number;
      threadId?: string;
    },
  ): Promise<MailDraftOutput> {
    let threadContext = "";

    if (input.mode === "reply" && input.accountId !== undefined && input.threadId !== undefined) {
      const messages = await this.mail.getThread(
        actor.orgId,
        actor.userId,
        input.threadId,
        input.accountId,
      );
      const capped = messages.slice(0, THREAD_MSG_MAX);
      threadContext = capped
        .map((m) => {
          const text = stripHtml(m.bodyHtml ?? m.bodyText ?? "").slice(0, BODY_CHAR_MAX);
          return `From: ${m.from.email} | Date: ${m.date}\n${text}`;
        })
        .join("\n\n---\n\n");
    }

    const system =
      "You are an email writing assistant. Generate an email draft based on the instruction. Output only valid JSON with 'subject' (string) and 'bodyHtml' (string). The bodyHtml must use ONLY semantic HTML: p, br, ul, li tags — no divs, spans, tables, styles, or scripts. Keep it professional and concise.";

    const userParts = [
      `Mode: ${input.mode}`,
      `Instruction: ${input.instruction}`,
    ];
    if (threadContext) {
      userParts.push(`Thread context (for reply):\n${threadContext}`);
    }
    const user = userParts.join("\n\n");

    const result = await this.gateway.invokeStructured({
      actor: { orgId: actor.orgId, userId: actor.userId },
      feature: "mail.draft",
      prompt: { system, user },
      tier: "fast",
      schema: MailDraftOutputSchema,
      charge: true,
    });

    return unwrapAiResult(result);
  }
}

export type { MailInboxSummaryOutput, MailThreadSummaryOutput, MailDraftOutput };
