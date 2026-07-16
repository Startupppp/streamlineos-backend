import { Inject, Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { tool } from "ai";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { users } from "../../db/schema";
import { ToolAccessService } from "./tool-access.service";
import { AiConfirmationService } from "../ai-confirmation/ai-confirmation.service";
import { EmailOutboxService } from "../email/email-outbox.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

export interface CommsActionsContext {
  actor: CurrentUserContext;
}

@Injectable()
export class CommsActionsTools {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly toolAccess: ToolAccessService,
    private readonly confirmation: AiConfirmationService,
    private readonly emailOutbox: EmailOutboxService,
    private readonly moduleRef: ModuleRef,
  ) {}

  buildTools(ctx: CommsActionsContext) {
    const { orgId, userId } = ctx.actor;

    return {
      sendEmail: tool({
        description: "Send an email on behalf of the user. Returns a confirmation card — the user must confirm before the email is sent.",
        inputSchema: z.object({
          toEmail: z.string().email().describe("Recipient email address"),
          subject: z.string().min(1).max(200).describe("Email subject"),
          body: z.string().min(1).max(5000).describe("Email body text"),
        }),
        execute: async ({ toEmail, subject, body }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "chat:messages:write");
          if (deny) return { denied: true, reason: deny };

          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "email.send",
            payload: { toEmail, subject, body },
          });

          return {
            requiresConfirmation: true,
            proposalId,
            token,
            expiresAt,
            action: "email.send",
            summary: `Send email to ${toEmail}: ${subject}`,
            preview: { toEmail, subject, bodyPreview: body.slice(0, 100) + (body.length > 100 ? "…" : "") },
          };
        },
      }),

      postChannelMessage: tool({
        description: "Post a message to a named chat channel. Returns a confirmation card — the user must confirm before the message is posted.",
        inputSchema: z.object({
          channelName: z.string().min(1).describe("Name of the channel to post to"),
          message: z.string().min(1).max(5000).describe("Message content to post"),
        }),
        execute: async ({ channelName, message }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "chat:messages:write");
          if (deny) return { denied: true, reason: deny };

          const rows = await this.db.execute(
            sql`SELECT id, name FROM chat_channels WHERE org_id = ${orgId} AND name ILIKE ${"%" + channelName + "%"} AND deleted_at IS NULL LIMIT 1`,
          );

          const row = rows[0] as Record<string, unknown> | undefined;
          if (!row) {
            return { success: false, message: `Channel matching "${channelName}" not found in this org.` };
          }

          const channelId = Number(row["id"]);

          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "chat.postChannel",
            payload: { channelId, channelName: String(row["name"]), message },
          });

          return {
            requiresConfirmation: true,
            proposalId,
            token,
            expiresAt,
            action: "chat.postChannel",
            summary: `Post to #${String(row["name"])}`,
            preview: { channelName: String(row["name"]), message },
          };
        },
      }),

      grantRecognition: tool({
        description: "Send a recognition/kudos badge to a team member. Returns a confirmation card — the user must confirm before the recognition is sent.",
        inputSchema: z.object({
          toUserId: z.string().describe("User ID of the recipient"),
          message: z.string().min(10).max(500).describe("Recognition message"),
          category: z
            .enum(["KUDOS", "TEAMWORK", "INNOVATION", "LEADERSHIP", "ABOVE_AND_BEYOND"])
            .default("KUDOS")
            .describe("Recognition category"),
        }),
        execute: async ({ toUserId, message, category }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "hr:engagement:manage");
          if (deny) return { denied: true, reason: deny };

          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "hr.grantRecognition",
            payload: { toUserId, message, category },
          });

          return {
            requiresConfirmation: true,
            proposalId,
            token,
            expiresAt,
            action: "hr.grantRecognition",
            summary: `Send ${category} recognition`,
            preview: { toUserId, category, messagePreview: message.slice(0, 80) + (message.length > 80 ? "…" : "") },
          };
        },
      }),

      grantBonus: tool({
        description: "Grant a bonus to an employee. Creates a PENDING bonus that a payroll admin approves before payout. Returns a confirmation card — the user must confirm before the bonus is created.",
        inputSchema: z.object({
          employeeId: z.string().min(1).describe("Employee user ID"),
          type: z
            .enum(["PERFORMANCE", "FESTIVAL", "REFERRAL", "SPOT", "ANNUAL", "JOINING", "RETENTION", "COMMISSION", "ADJUSTMENT"])
            .default("SPOT")
            .describe("Bonus type"),
          amount: z.number().positive().describe("Bonus amount"),
          reason: z.string().min(3).max(500).describe("Reason for the bonus"),
          month: z.string().regex(/^\d{4}-\d{2}$/).describe("Pay month in YYYY-MM format"),
          taxable: z.boolean().default(true).describe("Whether the bonus is taxable"),
        }),
        execute: async ({ employeeId, type, amount, reason, month, taxable }) => {
          const deny = await this.toolAccess.denyReason(orgId, userId, "hr:bonuses:manage");
          if (deny) return { denied: true, reason: deny };

          const [employee] = await this.db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(and(eq(users.id, employeeId), eq(users.orgId, orgId)))
            .limit(1);
          if (!employee) {
            return { success: false, message: "Employee not found in this organization." };
          }

          const employeeName = employee.name ?? employeeId;

          const { proposalId, token, expiresAt } = await this.confirmation.propose({
            orgId,
            userId,
            action: "hr.grantBonus",
            payload: { employeeId, type, amount, reason, month, taxable },
          });

          return {
            requiresConfirmation: true,
            proposalId,
            token,
            expiresAt,
            action: "hr.grantBonus",
            summary: `Grant ${type} bonus of ${amount} to ${employeeName} (${month})`,
            preview: { employee: employeeName, type, amount, month, reason, status: "Creates a PENDING bonus for payroll approval" },
          };
        },
      }),
    };
  }
}
