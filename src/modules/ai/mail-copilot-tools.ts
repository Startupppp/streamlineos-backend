import { Injectable } from "@nestjs/common";
import { tool } from "ai";
import { z } from "zod";
import { ToolAccessService } from "./tool-access.service";
import { AiConfirmationService } from "../ai-confirmation/ai-confirmation.service";
import { MailService } from "../mail/mail.service";
import { MailAiService } from "../mail/mail-ai.service";
import { MailAccountsService } from "../mail/mail-accounts.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export interface MailCopilotContext {
  actor: CurrentUserContext;
}

@Injectable()
export class MailCopilotTools {
  constructor(
    private readonly mail: MailService,
    private readonly mailAi: MailAiService,
    private readonly toolAccess: ToolAccessService,
    private readonly mailAccounts: MailAccountsService,
    private readonly confirmation: AiConfirmationService,
  ) {}

  buildTools(ctx: MailCopilotContext) {
    const { orgId, userId } = ctx.actor;

    return {
      listRecentEmails: tool({
        description:
          "List recent emails from the user's inbox. Returns up to 10 message summaries including subject, sender, date, snippet, and read status.",
        inputSchema: z.object({
          accountEmail: z
            .string()
            .email()
            .optional()
            .describe("Filter to a specific connected email account"),
          folder: z
            .enum(["inbox", "sent", "archive", "trash", "starred"])
            .optional()
            .default("inbox")
            .describe("Folder to list messages from"),
        }),
        execute: async ({ accountEmail, folder }) => {
          const deny = await this.toolAccess.denyReason(
            orgId,
            userId,
            "mail:inbox:view",
          );
          if (deny) return { denied: true, reason: deny };

          try {
            const accounts = await this.mail.listAccounts(orgId, userId);
            if (accounts.length === 0)
              return { success: false, message: "No mail accounts connected." };

            let accountIdParam = "all";
            if (accountEmail) {
              const match = accounts.find(
                (a) => a.accountEmail === accountEmail,
              );
              if (!match)
                return {
                  success: false,
                  message: `No connected account found for ${accountEmail}.`,
                };
              accountIdParam = String(match.id);
            }

            const result = await this.mail.listMessages(
              orgId,
              userId,
              folder ?? "inbox",
              accountIdParam,
              10,
            );
            const messages = result.messages.map((m) => ({
              subject: m.subject,
              from: m.from.email,
              date: m.date,
              snippet: m.snippet,
              isRead: m.isRead,
            }));
            return { success: true, messages, total: messages.length };
          } catch {
            return {
              success: false,
              message: "Failed to list emails. Please try again.",
            };
          }
        },
      }),

      summarizeMailThread: tool({
        description:
          "Summarize an email thread, extract action items, and suggest a reply.",
        inputSchema: z.object({
          accountEmail: z
            .string()
            .email()
            .optional()
            .describe("The connected email account owning the thread"),
          threadId: z.string().min(1).describe("The thread ID to summarize"),
        }),
        execute: async ({ accountEmail, threadId }) => {
          const deny = await this.toolAccess.denyReason(
            orgId,
            userId,
            "mail:ai:use",
          );
          if (deny) return { denied: true, reason: deny };

          try {
            const accounts = await this.mail.listAccounts(orgId, userId);
            if (accounts.length === 0)
              return { success: false, message: "No mail accounts connected." };

            let accountId: number;
            if (accountEmail) {
              const match = accounts.find(
                (a) => a.accountEmail === accountEmail,
              );
              if (!match)
                return {
                  success: false,
                  message: `No connected account found for ${accountEmail}.`,
                };
              accountId = match.id;
            } else {
              const primary = accounts.find((a) => a.isPrimary) ?? accounts[0];
              if (!primary)
                return {
                  success: false,
                  message: "No mail accounts connected.",
                };
              accountId = primary.id;
            }

            const summary = await this.mailAi.threadSummary(
              ctx.actor,
              accountId,
              threadId,
            );
            return { success: true, ...summary };
          } catch {
            return {
              success: false,
              message: "Failed to summarize thread. Please try again.",
            };
          }
        },
      }),

      sendMailFromAccount: tool({
        description:
          "Send an email from the user's connected mail account. Returns a confirmation card — the user must confirm before the email is sent.",
        inputSchema: z.object({
          toEmail: z.string().email().describe("Recipient email address"),
          subject: z.string().min(1).max(500).describe("Email subject"),
          body: z.string().min(1).max(10000).describe("Email body text"),
          accountEmail: z
            .string()
            .email()
            .optional()
            .describe(
              "The connected email account to send from (uses primary if omitted)",
            ),
        }),
        execute: async ({ toEmail, subject, body, accountEmail }) => {
          const deny = await this.toolAccess.denyReason(
            orgId,
            userId,
            "mail:messages:send",
          );
          if (deny) return { denied: true, reason: deny };

          try {
            const accounts = await this.mail.listAccounts(orgId, userId);
            const activeAccounts = accounts.filter(
              (a) => a.status === "active",
            );
            if (activeAccounts.length === 0)
              return {
                success: false,
                message: "No active mail accounts connected.",
              };

            const resolvedAccount = accountEmail
              ? activeAccounts.find((a) => a.accountEmail === accountEmail)
              : (activeAccounts.find((a) => a.isPrimary) ??
                activeAccounts[activeAccounts.length - 1]);

            if (!resolvedAccount)
              return {
                success: false,
                message: `No active connected account found${accountEmail ? ` for ${accountEmail}` : ""}.`,
              };

            const fromEmail =
              resolvedAccount.accountEmail ?? resolvedAccount.id.toString();

            const { proposalId, token, expiresAt } =
              await this.confirmation.propose({
                orgId,
                userId,
                action: "mail.send",
                payload: {
                  accountId: resolvedAccount.id,
                  toEmail,
                  subject,
                  body,
                },
              });

            return {
              requiresConfirmation: true,
              proposalId,
              token,
              expiresAt,
              action: "mail.send",
              summary: `Send email from ${fromEmail} to ${toEmail}: ${subject}`,
              preview: {
                fromEmail,
                toEmail,
                subject,
                bodyPreview:
                  body.slice(0, 100) + (body.length > 100 ? "…" : ""),
              },
            };
          } catch {
            return {
              success: false,
              message: "Failed to prepare email. Please try again.",
            };
          }
        },
      }),
    };
  }
}
