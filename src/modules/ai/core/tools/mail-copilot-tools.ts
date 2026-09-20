import { Injectable, Inject } from "@nestjs/common";
import { z } from "zod";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { MailService } from "../../../mail/mail.service";
import { MailAiService } from "../../../mail/mail-ai.service";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import {
  defineTool,
  data,
  empty,
  failed,
  needsConnection,
  needsConfirmation,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";
import { resolveAnyMailConnection } from "./lib/mail-connection";

@AskOsTools()
@Injectable()
export class MailCopilotTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly mail: MailService,
    private readonly mailAi: MailAiService,
    private readonly confirmation: AiConfirmationService,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "listRecentEmails",
        description:
          "List recent emails from the user's inbox. Returns up to 10 message summaries including subject, sender, date, snippet, and read status.",
        input: z.object({
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
        permission: "mail:inbox:view",
        module: "mail",
        ownsTransaction: true,
        run: async ({ accountEmail, folder }, ctx) => {
          const { orgId, userId, membershipId } = ctx.actor;
          const connection = await runInNewTenantTransaction(this.db, orgId, () =>
            resolveAnyMailConnection(this.db, { orgId, userId, membershipId }),
          );
          if (!connection.connected) {
            return needsConnection(
              connection.toolkit,
              connection.reason,
              "Connect a mail account to read your inbox.",
            );
          }
          try {
            const accounts = await runInNewTenantTransaction(this.db, orgId, () =>
              this.mail.listAccounts(orgId, userId),
            );
            let accountIdParam = "all";
            if (accountEmail) {
              const match = accounts.find((a) => a.accountEmail === accountEmail);
              if (!match) return failed(`No connected account found for ${accountEmail}.`);
              accountIdParam = String(match.id);
            }
            const result = await this.mail.listMessages(
              orgId,
              userId,
              membershipId,
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
            if (messages.length === 0) return empty("emails");
            return data({ messages, total: messages.length });
          } catch {
            return failed("Failed to list emails. Please try again.");
          }
        },
      }),

      defineTool({
        key: "summarizeMailThread",
        description: "Summarize an email thread, extract action items, and suggest a reply.",
        input: z.object({
          accountEmail: z
            .string()
            .email()
            .optional()
            .describe("The connected email account owning the thread"),
          threadId: z.string().min(1).describe("The thread ID to summarize"),
        }),
        permission: "mail:ai:use",
        module: "mail",
        ownsTransaction: true,
        run: async ({ accountEmail, threadId }, ctx) => {
          const { orgId, userId, membershipId } = ctx.actor;
          const connection = await runInNewTenantTransaction(this.db, orgId, () =>
            resolveAnyMailConnection(this.db, { orgId, userId, membershipId }),
          );
          if (!connection.connected) {
            return needsConnection(
              connection.toolkit,
              connection.reason,
              "Connect a mail account to summarize threads.",
            );
          }
          try {
            const accounts = await runInNewTenantTransaction(this.db, orgId, () =>
              this.mail.listAccounts(orgId, userId),
            );
            let accountId: number;
            if (accountEmail) {
              const match = accounts.find((a) => a.accountEmail === accountEmail);
              if (!match) return failed(`No connected account found for ${accountEmail}.`);
              accountId = match.id;
            } else {
              const primary = accounts.find((a) => a.isPrimary) ?? accounts[0];
              if (!primary) return failed("No mail accounts found.");
              accountId = primary.id;
            }
            const summary = await this.mailAi.threadSummary(ctx.caller, accountId, threadId);
            return data(summary);
          } catch {
            return failed("Failed to summarize thread. Please try again.");
          }
        },
      }),

      defineTool({
        key: "sendMailFromAccount",
        description:
          "Send an email from the user's connected mail account.",
        input: z.object({
          toEmail: z.string().email().describe("Recipient email address"),
          subject: z.string().min(1).max(500).describe("Email subject"),
          body: z.string().min(1).max(10000).describe("Email body text"),
          accountEmail: z
            .string()
            .email()
            .optional()
            .describe("The connected email account to send from (uses primary if omitted)"),
        }),
        confirms: "mail.send",
        module: "mail",
        ownsTransaction: true,
        run: async ({ toEmail, subject, body, accountEmail }, ctx) => {
          const { orgId, userId, membershipId } = ctx.actor;
          const connection = await runInNewTenantTransaction(this.db, orgId, () =>
            resolveAnyMailConnection(this.db, { orgId, userId, membershipId }),
          );
          if (!connection.connected) {
            return needsConnection(
              connection.toolkit,
              connection.reason,
              "Connect a mail account to send emails.",
            );
          }
          try {
            const accounts = await runInNewTenantTransaction(this.db, orgId, () =>
              this.mail.listAccounts(orgId, userId),
            );
            const activeAccounts = accounts.filter((a) => a.status === "active");
            if (activeAccounts.length === 0) return failed("No active mail accounts found.");
            const resolvedAccount = accountEmail
              ? activeAccounts.find((a) => a.accountEmail === accountEmail)
              : (activeAccounts.find((a) => a.isPrimary) ?? activeAccounts[activeAccounts.length - 1]);
            if (!resolvedAccount) {
              return failed(`No active account found${accountEmail ? ` for ${accountEmail}` : ""}.`);
            }
            const fromEmail = resolvedAccount.accountEmail ?? resolvedAccount.id.toString();
            const { proposalId, token, expiresAt } = await this.confirmation.propose({
              orgId,
              userId,
              action: "mail.send",
              payload: { accountId: resolvedAccount.id, toEmail, subject, body },
            });
            return needsConfirmation({
              proposalId,
              token,
              action: "mail.send",
              summary: `Send email from ${fromEmail} to ${toEmail}: ${subject}`,
              preview: {
                fromEmail,
                toEmail,
                subject,
                bodyPreview: body.slice(0, 100) + (body.length > 100 ? "…" : ""),
              },
              expiresAt,
            });
          } catch {
            return failed("Failed to prepare email. Please try again.");
          }
        },
      }),
    ];
  }
}
