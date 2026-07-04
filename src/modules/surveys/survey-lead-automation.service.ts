import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, or, type SQL } from "drizzle-orm";
import { leads, surveyForms } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { LeadsService, isAssigneeNotMember } from "../leads/leads.service";
import { LeadsDetailService } from "../leads/leads-detail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TasksService } from "../tasks/tasks.service";
import type { AutomationRule } from "./survey-automation.service";

interface SubmittedAnswer {
  answerValue: unknown;
  answerText: string | null;
  question: { variableName: string | null } | null;
}

type Survey = typeof surveyForms.$inferSelect;
type ResponseSession = { id: number; orgId: string };

export function scoreToPriority(score: number): "HOT" | "WARM" | "COLD" {
  if (score >= 70) return "HOT";
  if (score >= 40) return "WARM";
  return "COLD";
}

export function extractAnswerMap(answers: SubmittedAnswer[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const answer of answers) {
    const key = answer.question?.variableName;
    if (!key) continue;
    const value = answer.answerText ?? (typeof answer.answerValue === "string" ? answer.answerValue : null);
    if (value) map[key] = value;
  }
  return map;
}

@Injectable()
export class SurveyLeadAutomationService {
  private readonly logger = new Logger(SurveyLeadAutomationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly leadsService: LeadsService,
    private readonly leadsDetail: LeadsDetailService,
    private readonly notifications: NotificationsService,
    private readonly tasksService: TasksService,
  ) {}

  async run(survey: Survey, session: ResponseSession, answers: SubmittedAnswer[], score: number, rules: AutomationRule[]) {
    const answerMap = extractAnswerMap(answers);
    for (const rule of rules) {
      if (rule.action.scoreThreshold != null && score < rule.action.scoreThreshold) continue;
      if (rule.action.type === "create_lead" || rule.action.type === "update_lead") {
        await this.runLeadAction(survey, session, answerMap, score, rule).catch((error: unknown) =>
          this.logger.error(`Lead automation failed for rule ${rule.id}`, error instanceof Error ? error.stack : error),
        );
      } else if (rule.action.type === "notify_owner") {
        await this.runNotifyOwner(survey, score).catch((error: unknown) =>
          this.logger.error(`Notify-owner automation failed for rule ${rule.id}`, error instanceof Error ? error.stack : error),
        );
      }
    }
  }

  private async findExistingLead(orgId: string, email: string | null, phone: string | null) {
    const conditions: SQL[] = [];
    if (email) conditions.push(eq(leads.email, email));
    if (phone) conditions.push(eq(leads.phone, phone));
    if (!conditions.length) return null;

    return this.db.query.leads.findFirst({
      where: and(eq(leads.orgId, orgId), or(...conditions)),
    });
  }

  private async runLeadAction(
    survey: Survey,
    session: ResponseSession,
    answerMap: Record<string, string>,
    score: number,
    rule: AutomationRule,
  ) {
    if (!survey.createdBy) {
      this.logger.warn(`Survey ${survey.id} has no creator; skipping lead automation`);
      return;
    }

    const email = answerMap.email || null;
    const phone = answerMap.phone || null;
    if (!email && !phone) return;

    const name = answerMap.name || answerMap.full_name || "Survey respondent";
    const notes = `Submitted survey "${survey.title}" (response #${session.id}), score ${score}.`;
    const existing = await this.findExistingLead(survey.orgId, email, phone);

    if (existing) {
      await this.leadsService.update(survey.orgId, survey.createdBy, existing.id, {
        notes: existing.notes ? `${existing.notes}\n${notes}` : notes,
        priority: scoreToPriority(score),
      });
      await this.leadsDetail.updateCustomData(survey.orgId, existing.id, {
        customData: { ...(existing.customData ?? {}), lastSurveyId: survey.id, lastSurveySessionId: session.id, lastSurveyScore: score },
      });
      return;
    }

    if (rule.action.type !== "create_lead") return;

    const created = await this.leadsService.create(survey.orgId, survey.createdBy, {
      name,
      email: email ?? undefined,
      phone: phone ?? undefined,
      company: answerMap.company,
      source: "other",
      priority: scoreToPriority(score),
      notes,
    });

    if (isAssigneeNotMember(created)) return;

    await this.leadsDetail.updateCustomData(survey.orgId, created.id, {
      customData: { surveyId: survey.id, surveySessionId: session.id, surveyScore: score },
    });

    if (Boolean(rule.action.config?.createFollowUpTask) && created.assignedToId) {
      await this.tasksService.create(survey.orgId, survey.createdBy, {
        title: `Follow up: ${created.name} (from ${survey.title})`,
        entityType: "LEAD",
        entityId: created.id,
        type: "CALL",
        assigneeId: created.assignedToId,
      });
    }
  }

  private async runNotifyOwner(survey: Survey, score: number) {
    if (!survey.createdBy) return;

    await this.notifications.create({
      orgId: survey.orgId,
      userId: survey.createdBy,
      type: "INFO",
      category: "CRM",
      sourceModule: "surveys",
      title: "High-scoring survey response",
      message: `"${survey.title}" received a response scoring ${score}.`,
      link: `/surveys/${survey.id}/results`,
    });
  }
}
