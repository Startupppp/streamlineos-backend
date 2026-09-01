import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  meetingActionItems,
  meetingAttendees,
  projectMeetings,
  organizationMembers,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { MeetingExtractActionsOutputSchema } from "../dto/ticket-ai.schemas";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { unwrapAiResult } from "./gateway-result.util";

@Injectable()
export class MeetingActionAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly audit: AuditService,
  ) {}

  async extractMeetingActions(orgId: string, userId: string, projectId: number, meetingId: number) {
    const ctx = await runInTenantTransaction(this.db, async () => {
      const [meeting] = await this.db
        .select({
          id: projectMeetings.id,
          title: projectMeetings.title,
          type: projectMeetings.type,
          scheduledAt: projectMeetings.scheduledAt,
          notes: projectMeetings.notes,
        })
        .from(projectMeetings)
        .where(
          and(
            eq(projectMeetings.id, meetingId),
            eq(projectMeetings.orgId, orgId),
            eq(projectMeetings.projectId, projectId),
            isNull(projectMeetings.deletedAt),
          ),
        )
        .limit(1);

      if (!meeting) throw new NotFoundException("Meeting not found");
      if (!meeting.notes || meeting.notes.trim() === "") return { empty: true as const };
      const notes = meeting.notes;

      const [attendeeRows, existingItems] = await Promise.all([
        this.db
          .select({
            firstName: users.firstName,
            lastName: users.lastName,
            name: users.name,
          })
          .from(meetingAttendees)
          .innerJoin(
            organizationMembers,
            and(
              eq(organizationMembers.orgId, meetingAttendees.orgId),
              eq(organizationMembers.id, meetingAttendees.membershipId),
            ),
          )
          .innerJoin(users, eq(users.id, organizationMembers.userId))
          .where(and(eq(meetingAttendees.meetingId, meetingId), eq(meetingAttendees.orgId, orgId)))
          .limit(20),
        this.db
          .select({ title: meetingActionItems.title })
          .from(meetingActionItems)
          .where(
            and(
              eq(meetingActionItems.meetingId, meetingId),
              eq(meetingActionItems.orgId, orgId),
              isNull(meetingActionItems.deletedAt),
            ),
          )
          .limit(20),
      ]);

      return { empty: false as const, meeting, notes, attendeeRows, existingItems };
    }, { orgId });

    if (ctx.empty) {
      return { actions: [], summary: "Meeting has no notes to extract actions from.", suggestions: true };
    }

    const { meeting, notes, attendeeRows, existingItems } = ctx;
    const attendeeNames = attendeeRows.map((r) => {
      const full = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
      return full !== "" ? full : (r.name ?? "");
    }).filter(Boolean);

    const existingTitles = existingItems.map((i) => i.title);

    const scheduledLabel = meeting.scheduledAt
      ? meeting.scheduledAt.toISOString().slice(0, 10)
      : "unscheduled";

    const system =
      "You are a meeting facilitator assistant. Extract action items from meeting notes. Propose ONLY items not already covered by existing action items. These are SUGGESTIONS ONLY — do not state they will be auto-created.";

    const existingBlock =
      existingTitles.length > 0
        ? existingTitles.map((t) => `- ${t}`).join("\n")
        : "None";

    const attendeesBlock = attendeeNames.length > 0 ? attendeeNames.join(", ") : "None listed";

    const user = `Meeting: "${meeting.title}" (${meeting.type}) | ${scheduledLabel}
Attendees: ${attendeesBlock}
Notes:
${notes.slice(0, 2000)}
Existing action items (do NOT duplicate): ${existingBlock}

Extract up to 10 proposed action items. Cite the attendee name when ownership is clear.`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "pm.extract-meeting-actions",
      prompt: { system, user },
      schema: MeetingExtractActionsOutputSchema,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    const data = unwrapAiResult(result);
    this.audit.log({ action: "ai.meeting.extract-actions", userId, orgId, resourceType: "meeting", resourceId: String(meetingId) });
    return { ...data, suggestions: true };
  }
}
