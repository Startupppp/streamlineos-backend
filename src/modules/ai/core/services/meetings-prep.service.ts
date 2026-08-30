import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  calendarEvents,
  eventAttendees,
  organizationMembers,
  userIntegrationConnections,
  users,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiConfirmationService, type ProposeResult } from "../../confirmation/ai-confirmation.service";
import { ComposioGateway, ComposioToolError } from "../../../integrations/core/composio.gateway";
import { unwrapAiResult } from "./gateway-result.util";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import type { TenantTx } from "../../../../common/tenant/with-tenant";
import { agendaOutputSchema, followUpOutputSchema, type AgendaOutput, type FollowUpOutput } from "../dto/meetings-output.schemas";

const MAX_NOTES = 2000;

function trunc(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > MAX_NOTES ? s.slice(0, MAX_NOTES) + "…" : s;
}

interface MeetingAttendee {
  userId: string;
  name: string | null;
  status: string;
}

interface MeetingEventContext {
  id: number;
  title: string;
  startDate: Date;
  endDate: Date;
  description: string | null;
  location: string | null;
  meetingUrl: string | null;
  agenda: string | null;
  entityType: string | null;
  entityId: string | null;
  linkedLeadId: number | null;
  linkedDealId: number | null;
  createdBy: string;
  externalEventId: string | null;
  integrationConnectionId: number | null;
  attendees: MeetingAttendee[];
}

@Injectable()
export class MeetingsPrepService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
    private readonly confirmation: AiConfirmationService,
    private readonly composio: ComposioGateway,
  ) {}

  private parseEventId(raw: string): number {
    const id = parseInt(raw, 10);
    if (Number.isNaN(id) || id <= 0) throw new NotFoundException("Invalid event ID");
    return id;
  }

  private async loadEvent(orgId: string, eventId: number, tx: TenantTx): Promise<MeetingEventContext> {
    const rows = await tx
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        startDate: calendarEvents.startDate,
        endDate: calendarEvents.endDate,
        description: calendarEvents.description,
        location: calendarEvents.location,
        meetingUrl: calendarEvents.meetingUrl,
        agenda: calendarEvents.agenda,
        entityType: calendarEvents.entityType,
        entityId: calendarEvents.entityId,
        linkedLeadId: calendarEvents.linkedLeadId,
        linkedDealId: calendarEvents.linkedDealId,
        createdBy: calendarEvents.createdBy,
        externalEventId: calendarEvents.externalEventId,
        integrationConnectionId: calendarEvents.integrationConnectionId,
      })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.orgId, orgId)))
      .limit(1);

    const event = rows[0];
    if (!event) throw new NotFoundException("Calendar event not found");

    const attendeeRows = await tx
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        status: eventAttendees.status,
      })
      .from(eventAttendees)
      .innerJoin(
        organizationMembers,
        and(eq(eventAttendees.orgId, organizationMembers.orgId), eq(eventAttendees.membershipId, organizationMembers.id)),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(eventAttendees.orgId, orgId), eq(eventAttendees.eventId, eventId)));

    return {
      ...event,
      attendees: attendeeRows,
    };
  }

  private async getActiveConnections(orgId: string, userId: string, tx: TenantTx) {
    return tx
      .select({
        id: userIntegrationConnections.id,
        toolkit: userIntegrationConnections.toolkit,
        accountEmail: userIntegrationConnections.accountEmail,
        composioConnectedAccountId: userIntegrationConnections.composioConnectedAccountId,
        isPrimary: userIntegrationConnections.isPrimary,
      })
      .from(userIntegrationConnections)
      .where(
        and(
          eq(userIntegrationConnections.orgId, orgId),
          eq(userIntegrationConnections.userId, userId),
          eq(userIntegrationConnections.status, "active"),
        ),
      );
  }

  async draftAgenda(
    orgId: string,
    userId: string,
    rawEventId: string,
    opts: { includeCrmContext?: boolean; includeProjectContext?: boolean },
  ): Promise<{ agenda: AgendaOutput; connectedIntegrations: boolean }> {
    const eventId = this.parseEventId(rawEventId);
    const { event, connections } = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const event = await this.loadEvent(orgId, eventId, tx);
        const connections = this.composio.isConfigured()
          ? await this.getActiveConnections(orgId, userId, tx)
          : [];
        return { event, connections };
      },
      { orgId },
    );

    const hasConnections = connections.length > 0;

    const attendeeList =
      event.attendees.length > 0
        ? event.attendees.map((a) => `- ${a.name ?? a.userId} (${a.status})`).join("\n")
        : "No confirmed attendees found.";

    const crmContext =
      opts.includeCrmContext && (event.linkedLeadId ?? event.linkedDealId)
        ? `CRM Link: ${event.linkedLeadId ? `Lead #${event.linkedLeadId}` : `Deal #${event.linkedDealId}`}`
        : "";

    const userPrompt = `Generate a structured meeting agenda for the following meeting.

MEETING DETAILS:
- Title: ${event.title}
- Date/Time: ${event.startDate.toLocaleString("en-IN", { dateStyle: "full", timeStyle: "short" })}
- Duration: ${Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000)} minutes
- Location: ${event.location ?? "Not specified"}
- Meeting URL: ${event.meetingUrl ?? "Not specified"}
- Description: ${trunc(event.description)}
- Existing Agenda Notes: ${trunc(event.agenda)}
${crmContext ? `\n${crmContext}` : ""}

ATTENDEES:
${attendeeList}

Generate:
1. A clear meeting agenda with timed sections
2. 3-5 key topics to cover
3. Suggested total duration
4. Preparation notes for the organizer
5. Citations referencing the data sources used (meeting details, attendee list, CRM context if present)`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "meetings.prep",
      prompt: {
        system:
          "You are an executive assistant preparing meeting agendas. Generate structured, actionable agendas that help teams run efficient meetings. Be concise and time-aware.",
        user: userPrompt,
      },
      schema: agendaOutputSchema,
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    const agenda = unwrapAiResult(result);
    return { agenda, connectedIntegrations: hasConnections };
  }

  async draftFollowUp(
    orgId: string,
    userId: string,
    rawEventId: string,
    meetingNotes: string | undefined,
    actionItems: string[] | undefined,
  ): Promise<{ followUp: FollowUpOutput; eventTitle: string }> {
    const eventId = this.parseEventId(rawEventId);
    const event = await runInTenantTransaction(
      this.db,
      (tx) => this.loadEvent(orgId, eventId, tx),
      { orgId },
    );

    const attendeeList =
      event.attendees.length > 0
        ? event.attendees.map((a) => a.name ?? a.userId).join(", ")
        : "Not specified";

    const notesSection = meetingNotes
      ? `\nMEETING NOTES FROM ORGANIZER:\n${trunc(meetingNotes)}`
      : "";

    const itemsSection =
      actionItems && actionItems.length > 0
        ? `\nIDENTIFIED ACTION ITEMS:\n${actionItems.map((i) => `- ${i}`).join("\n")}`
        : "";

    const userPrompt = `Generate a professional post-meeting follow-up email for the following meeting.

MEETING DETAILS:
- Title: ${event.title}
- Date: ${event.startDate.toLocaleDateString("en-IN", { dateStyle: "full" })}
- Attendees: ${attendeeList}
${notesSection}
${itemsSection}

Generate:
1. A clear email subject line
2. A professional follow-up email body (in markdown)
3. A structured list of action items with assignees and due dates where identifiable
4. A suggested next meeting date if a follow-up is needed`;

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "meetings.follow-up",
      prompt: {
        system:
          "You are an executive assistant generating post-meeting follow-up emails. Write clear, professional follow-ups that summarize outcomes and clearly assign action items.",
        user: userPrompt,
      },
      schema: followUpOutputSchema,
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    const followUp = unwrapAiResult(result);
    return { followUp, eventTitle: event.title };
  }

  async proposeSendFollowUp(
    orgId: string,
    userId: string,
    rawEventId: string,
    followUpDraft: FollowUpOutput,
    channel: "calendar" | "none",
  ): Promise<ProposeResult> {
    const eventId = this.parseEventId(rawEventId);
    await runInTenantTransaction(
      this.db,
      (tx) => this.loadEvent(orgId, eventId, tx),
      { orgId },
    );

    return this.confirmation.propose({
      orgId,
      userId,
      action: "meetings.send-follow-up",
      payload: {
        eventId,
        followUpSubject: followUpDraft.subject,
        followUpBody: followUpDraft.body,
        followUpActionItems: JSON.stringify(followUpDraft.actionItems),
        followUpNextMeetingDate: followUpDraft.nextMeetingDate ?? null,
        channel,
      },
      ttlSeconds: 180,
      idempotencyKey: `meetings-followup-${orgId}-${userId}-${eventId}`,
    });
  }

  async executeSendFollowUp(
    orgId: string,
    userId: string,
    token: string,
  ): Promise<{ executed: boolean; channel?: string; error?: string; message?: string }> {
    const confirmed = await this.confirmation.confirm({ token, actor: { orgId, userId } });

    const rawPayload = confirmed.payload;
    const eventId = Number(rawPayload["eventId"]);
    const followUpBody = String(rawPayload["followUpBody"] ?? "");
    const channel = String(rawPayload["channel"] ?? "none") as "calendar" | "none";

    const event = await runInTenantTransaction(
      this.db,
      (tx) => this.loadEvent(orgId, eventId, tx),
      { orgId },
    );

    if (channel === "none") {
      await this.confirmation.markExecuted(confirmed.proposalId, { channel: "none", status: "acknowledged" }, orgId);
      return { executed: true, channel: "none" };
    }

    if (!this.composio.isConfigured()) {
      throw new ForbiddenException("Composio integration is not configured");
    }

    const connections = await runInTenantTransaction(
      this.db,
      (tx) => this.getActiveConnections(orgId, userId, tx),
      { orgId },
    );
    const primary = connections.find((c) => c.isPrimary) ?? connections[0];

    if (!primary) {
      return { executed: false, error: "no_connection", message: "No active calendar connection found" };
    }

    const description = [
      event.description ?? "",
      "",
      "--- Follow-up ---",
      followUpBody,
    ]
      .join("\n")
      .trim();

    try {
      if (primary.toolkit === "googlecalendar") {
        const externalId = event.externalEventId;
        if (!externalId) {
          return { executed: false, error: "no_external_event", message: "No linked external calendar event to update" };
        }
        await this.composio.executeTool(
          "GOOGLECALENDAR_UPDATE_EVENT",
          userId,
          { event_id: externalId, description },
          primary.composioConnectedAccountId,
        );
      } else {
        await this.composio.executeTool(
          "OUTLOOK_CALENDAR_CREATE_EVENT",
          userId,
          {
            subject: `Follow-up: ${event.title}`,
            body: followUpBody,
            start_datetime: new Date(Date.now() + 5 * 60_000).toISOString(),
            end_datetime: new Date(Date.now() + 35 * 60_000).toISOString(),
          },
          primary.composioConnectedAccountId,
        );
      }

      await this.confirmation.markExecuted(confirmed.proposalId, { channel, status: "sent" }, orgId);
      return { executed: true, channel };
    } catch (error) {
      if (error instanceof ComposioToolError && error.isAuthError) {
        return { executed: false, error: "auth_required", message: error.message };
      }
      throw error;
    }
  }
}
