import { Inject, Injectable } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { tasks } from "../../../db/schema";
import { logger } from "../../../common/logger/logger.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { AutomationEmailService } from "../../automation/automation-email.service";
import { HR_WORKFLOW_STARTER, type HrWorkflowStarterPort } from "./hr-workflow-starter.port";
import type { HrAutomationAction, HrActionResult } from "../../../db/schema/hr/automation-engine";
import { checkWebhookUrl } from "../../../common/security/ssrf-guard";
import { outboundTraceHeaders } from "../../../common/outbound/call-provider";

const WEBHOOK_TIMEOUT_MS = 10_000;

@Injectable()
export class HrAutomationActionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly email: AutomationEmailService,
    @Inject(HR_WORKFLOW_STARTER) private readonly workflowStarter: HrWorkflowStarterPort,
  ) {}

  async execute(
    orgId: string,
    action: HrAutomationAction,
    payload: Record<string, unknown>,
    ruleWebhookSecret: string | null,
  ): Promise<HrActionResult> {
    try {
      return await this.dispatch(orgId, action, payload, ruleWebhookSecret);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Action execution failed";
      logger.error("hr-automation action failed", { orgId, type: action.type, error });
      return { type: action.type, ok: false, error: message };
    }
  }

  private async dispatch(
    orgId: string,
    action: HrAutomationAction,
    payload: Record<string, unknown>,
    ruleWebhookSecret: string | null,
  ): Promise<HrActionResult> {
    switch (action.type) {
      case "create_task": {
        const dueDate = typeof action.config.dueInDays === "number"
          ? new Date(Date.now() + action.config.dueInDays * 86_400_000)
          : null;
        await this.db.insert(tasks).values({
          orgId,
          title: action.config.title,
          assigneeId: action.config.assigneeId ?? null,
          dueDate,
        });
        return { type: action.type, ok: true };
      }

      case "start_workflow": {
        const result = await this.workflowStarter.startWorkflow(orgId, action.config.workflowId, payload);
        if (result === null) {
          return { type: action.type, ok: true, data: { status: "deferred", integration: "hr-workflows" } };
        }
        return { type: action.type, ok: true, data: { executionId: result.executionId } };
      }

      case "send_notification": {
        await this.notifications.create({
          orgId,
          userId: String(payload.employeeId ?? ""),
          title: action.config.title,
          message: action.config.message,
          link: action.config.link,
          category: "HRMS",
          sourceModule: "hr-automations",
        });
        return { type: action.type, ok: true };
      }

      case "send_email": {
        await this.email.send({
          to: action.config.to,
          subject: action.config.subject,
          html: action.config.body,
        });
        return { type: action.type, ok: true };
      }

      case "assign_document":
        return { type: action.type, ok: true, data: { status: "deferred", integration: "hr-documents", documentTypeId: action.config.documentTypeId } };

      case "generate_letter":
        return { type: action.type, ok: true, data: { status: "deferred", integration: "hr-letters", templateId: action.config.templateId } };

      case "assign_course":
        return { type: action.type, ok: true, data: { status: "deferred", integration: "hr-learning", courseId: action.config.courseId } };

      case "assign_asset":
        return { type: action.type, ok: true, data: { status: "deferred", integration: "hr-assets", assetTypeId: action.config.assetTypeId } };

      case "create_hr_case":
        return { type: action.type, ok: true, data: { status: "deferred", integration: "hr-helpdesk", subject: action.config.subject } };

      case "update_field":
        return { type: action.type, ok: true, data: { status: "deferred", integration: "hr-directory", field: action.config.field, value: action.config.value } };

      case "call_webhook":
        return await this.callWebhook(orgId, action.config.url, action.config.method ?? "POST", payload, ruleWebhookSecret);

      default: {
        const _exhaustive: never = action;
        return { type: (_exhaustive as HrAutomationAction).type, ok: false, error: "Unknown action type" };
      }
    }
  }

  private async callWebhook(
    orgId: string,
    url: string,
    method: "POST" | "PUT",
    payload: Record<string, unknown>,
    secret: string | null,
  ): Promise<HrActionResult> {
    const urlCheck = await checkWebhookUrl(url);
    if (!urlCheck.allowed) {
      return { type: "call_webhook", ok: false, error: `SSRF: ${urlCheck.reason}` };
    }

    const body = JSON.stringify({ orgId, payload, timestamp: new Date().toISOString() });
    const headers: Record<string, string> = { "Content-Type": "application/json", ...outboundTraceHeaders() };
    if (secret) {
      headers["X-StreamlineOS-Signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { type: "call_webhook", ok: false, error: `HTTP ${response.status}` };
    }
    return { type: "call_webhook", ok: true };
  }
}
