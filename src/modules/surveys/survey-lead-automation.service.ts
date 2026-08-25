import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { surveyForms } from "../../db/schema";
import { businessParties, leadPartyMap } from "../../db/schema/party";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { PARTY_OF_LEAD } from "../crm/crm-party-reads";
import { resolvePartyByIdentifier } from "../party/party-identifiers";
import { leadViewFrom, type LeadView } from "../leads/lead-party-reader";
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

  /**
   * The lead this respondent already is, if the organisation has one.
   *
   * Through `party_identifiers` rather than `leads.email = ?`. That table is the
   * one place an address or a number is matched, and it matches on the
   * normalised value — so `Jane@Acme.example` finds the lead entered as
   * `jane@acme.example`, and `+44 20 7123 4567` finds `+442071234567`. The
   * column comparison this replaces found neither, which is how a survey
   * respondent who had already been entered got a second lead record.
   *
   * Email first, then phone, matching the order the old `OR` implied and
   * nothing more: an email address identifies one person, a shared switchboard
   * number does not.
   *
   * A claim held by a soft-deleted party is released by the resolver rather than
   * answered, so a deleted lead no longer absorbs the response. The old read
   * carried no `deleted_at` predicate at all and would update the deleted row.
   */
  private async findExistingLead(
    orgId: string,
    email: string | null,
    phone: string | null,
  ): Promise<LeadView | null> {
    const partyId =
      (email ? await resolvePartyByIdentifier(this.db, orgId, "email", email) : null) ??
      (phone ? await resolvePartyByIdentifier(this.db, orgId, "phone", phone) : null);
    if (!partyId) return null;

    // A party reached by email may be a client or a contact and never a lead, in
    // which case there is no map row and no lead to update -- exactly what the
    // `leads`-only search used to conclude.
    const [row] = await this.db
      .select({ leadId: leadPartyMap.leadId, party: businessParties })
      .from(leadPartyMap)
      .innerJoin(businessParties, PARTY_OF_LEAD)
      .where(
        and(
          eq(leadPartyMap.organizationId, orgId),
          eq(businessParties.organizationId, orgId),
          eq(businessParties.partyId, partyId),
        ),
      )
      // A merge leaves one party answering for several lead ids. The oldest is
      // the record the organisation has been working, and picking it by rule
      // rather than by heap order keeps the note landing in the same place.
      .orderBy(asc(leadPartyMap.leadId))
      .limit(1);

    return row ? leadViewFrom(row.leadId, row.party) : null;
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
