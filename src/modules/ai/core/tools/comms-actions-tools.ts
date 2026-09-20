import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { and, eq, ilike, inArray, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { users, organizationMembers, chatChannels } from "../../../../db/schema";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { ChatChannelsService } from "../../../chat/chat-channels.service";
import { MailService } from "../../../mail/mail.service";
import {
  type AskOsToolDefinition,
  type AskOsToolProvider,
  defineTool,
  data,
  empty,
  failed,
  needsConfirmation,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";
import { requireMailConnection } from "./lib/mail-connection";

const CHANNEL_NOT_FOUND_HINT = "Channel not found or not accessible." as const;

@AskOsTools()
@Injectable()
export class CommsActionsTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly confirmation: AiConfirmationService,
    private readonly channels: ChatChannelsService,
    private readonly mail: MailService,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "sendEmail",
        description: "Send an email on behalf of the user.",
        input: z.object({
          toEmail: z.string().email().describe("Recipient email address"),
          subject: z.string().min(1).max(200).describe("Email subject"),
          body: z.string().min(1).max(5000).describe("Email body text"),
        }),
        confirms: "email.send",
        module: "chat",
        run: async ({ toEmail, subject, body }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "email.send",
            payload: { toEmail, subject, body },
          });

          return needsConfirmation({
            proposalId,
            token,
            expiresAt,
            action: "email.send",
            summary: `Send email to ${toEmail}: ${subject}`,
            preview: { toEmail, subject, bodyPreview: body.slice(0, 100) + (body.length > 100 ? "…" : "") },
          });
        },
      }),

      defineTool({
        key: "postChannelMessage",
        description: "Post a message to a named chat channel.",
        input: z.object({
          channelName: z.string().min(1).describe("Name of the channel to post to"),
          message: z.string().min(1).max(5000).describe("Message content to post"),
        }),
        confirms: "chat.postChannel",
        module: "chat",
        run: async ({ channelName, message }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const memberChannelIds = await this.channels.listMemberChannelIds(ctx.actor);
          if (memberChannelIds.length === 0) return empty("channel", CHANNEL_NOT_FOUND_HINT);

          const [channel] = await this.db
            .select({ id: chatChannels.id, name: chatChannels.name })
            .from(chatChannels)
            .where(
              and(
                eq(chatChannels.orgId, orgId),
                inArray(chatChannels.id, memberChannelIds),
                ilike(chatChannels.name, `%${channelName}%`),
                eq(chatChannels.isArchived, false),
              ),
            )
            .limit(1);

          if (!channel) return empty("channel", CHANNEL_NOT_FOUND_HINT);

          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "chat.postChannel",
            payload: { channelId: channel.id, channelName: channel.name, message },
          });

          return needsConfirmation({
            proposalId,
            token,
            expiresAt,
            action: "chat.postChannel",
            summary: `Post to #${channel.name}`,
            preview: { channelName: channel.name, message },
          });
        },
      }),

      defineTool({
        key: "grantRecognition",
        description: "Send a recognition/kudos badge to a team member.",
        input: z.object({
          toUserId: z.string().describe("User ID of the recipient"),
          message: z.string().min(10).max(500).describe("Recognition message"),
          category: z
            .enum(["KUDOS", "TEAMWORK", "INNOVATION", "LEADERSHIP", "ABOVE_AND_BEYOND"])
            .default("KUDOS")
            .describe("Recognition category"),
        }),
        confirms: "hr.grantRecognition",
        module: "hr",
        run: async ({ toUserId, message, category }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "hr.grantRecognition",
            payload: { toUserId, message, category },
          });

          return needsConfirmation({
            proposalId,
            token,
            expiresAt,
            action: "hr.grantRecognition",
            summary: `Send ${category} recognition`,
            preview: { toUserId, category, messagePreview: message.slice(0, 80) + (message.length > 80 ? "…" : "") },
          });
        },
      }),

      defineTool({
        key: "grantBonus",
        description:
          "Grant a bonus to an employee. Creates a PENDING bonus that a payroll admin approves before payout.",
        input: z.object({
          employeeId: z.string().min(1).describe("Employee user ID"),
          type: z
            .enum([
              "PERFORMANCE",
              "FESTIVAL",
              "REFERRAL",
              "SPOT",
              "ANNUAL",
              "JOINING",
              "RETENTION",
              "COMMISSION",
              "ADJUSTMENT",
            ])
            .default("SPOT")
            .describe("Bonus type"),
          amount: z.number().positive().describe("Bonus amount"),
          reason: z.string().min(3).max(500).describe("Reason for the bonus"),
          month: z.string().regex(/^\d{4}-\d{2}$/).describe("Pay month in YYYY-MM format"),
          taxable: z.boolean().default(true).describe("Whether the bonus is taxable"),
        }),
        confirms: "hr.grantBonus",
        module: "hr",
        run: async ({ employeeId, type, amount, reason, month, taxable }, ctx) => {
          const { orgId, userId } = ctx.actor;
          const [employee] = await this.db
            .select({ id: users.id, name: users.name })
            .from(users)
            .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
            .where(
              and(
                eq(users.id, employeeId),
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.status, "ACTIVE"),
                eq(users.isActive, true),
                isNull(users.deletedAt),
              ),
            )
            .limit(1);

          if (!employee) return empty("employee", "Employee not found in this organization.");

          const employeeName = employee.name ?? employeeId;
          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "hr.grantBonus",
            payload: { employeeId, type, amount, reason, month, taxable },
          });

          return needsConfirmation({
            proposalId,
            token,
            expiresAt,
            action: "hr.grantBonus",
            summary: `Grant ${type} bonus of ${amount} to ${employeeName} (${month})`,
            preview: {
              employee: employeeName,
              type,
              amount,
              month,
              reason,
              status: "Creates a PENDING bonus for payroll approval",
            },
          });
        },
      }),

      defineTool({
        key: "archiveMailMessage",
        description: "Archive an email message from the user's connected mail account.",
        input: z.object({
          messageId: z.string().min(1).describe("The message ID to archive"),
          threadId: z
            .string()
            .min(1)
            .optional()
            .describe("The thread ID (required for Gmail archive)"),
          accountEmail: z
            .string()
            .email()
            .optional()
            .describe("Connected email account to use (uses primary if omitted)"),
        }),
        confirms: "mail.archive",
        module: "mail",
        ownsTransaction: true,
        run: async ({ messageId, threadId, accountEmail }, ctx) => {
          const { orgId, userId, membershipId } = ctx.actor;
          const gate = await requireMailConnection(
            this.db,
            { orgId, userId, membershipId },
            "Connect a mail account to archive messages.",
          );
          if (!gate.connected) return gate.outcome;
          try {
            const accounts = await runInNewTenantTransaction(this.db, orgId, () =>
              this.mail.listAccounts(orgId, userId),
            );
            const activeAccounts = accounts.filter((a) => a.status === "active");
            if (activeAccounts.length === 0) return failed("No active mail accounts found.");
            const resolvedAccount = accountEmail
              ? activeAccounts.find((a) => a.accountEmail === accountEmail)
              : (activeAccounts.find((a) => a.isPrimary) ?? activeAccounts[activeAccounts.length - 1]);
            if (!resolvedAccount)
              return failed(
                `No active account found${accountEmail ? ` for ${accountEmail}` : ""}.`,
              );
            const { proposalId, token, expiresAt } = await this.confirmation.propose({
              orgId,
              userId,
              action: "mail.archive",
              payload: { accountId: resolvedAccount.id, messageId, threadId },
            });
            return needsConfirmation({
              proposalId,
              token,
              action: "mail.archive",
              summary: `Archive message ${messageId}`,
              preview: { accountEmail: resolvedAccount.accountEmail, messageId, threadId },
              expiresAt,
            });
          } catch {
            return failed("Failed to prepare archive action. Please try again.");
          }
        },
      }),
    ];
  }
}
