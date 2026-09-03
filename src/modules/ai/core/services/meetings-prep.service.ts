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
import type { AiTextStream } from "../gateway/ai-gateway-stream.helper";
import {
  agendaSources,
  agendaStreamPrompt,
  agendaStructuredPrompt,
  followUpPrompt,
  followUpSources,
  followUpStreamPrompt,
  type MeetingAttendeeContext,
  type MeetingContextOptions,
  type MeetingSource,
} from "./meetings-prep-prompt";

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
  externalEventId: string | null;
  integrationConnectionId: number | null;
  attendees: MeetingAttendeeContext[];
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

  /**
   * Loads the event, its attendees and the caller's calendar connections once.
   * Both representations of a prep — the buffered structured one and the
   * streamed prose one — start here, so they always describe the same meeting.
   */
  private async loadPrepContext(
    orgId: string,
    userId: string,
    rawEventId: string,
  ): Promise<{ event: MeetingEventContext; connectedIntegrations: boolean }> {
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
    return { event, connectedIntegrations: connections.length > 0 };
  }

  async draftAgenda(
    orgId: string,
    userId: string,
    rawEventId: string,
    opts: MeetingContextOptions,
  ): Promise<{ agenda: AgendaOutput; connectedIntegrations: boolean }> {
    const { event, connectedIntegrations } = await this.loadPrepContext(orgId, userId, rawEventId);

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "meetings.prep",
      prompt: agendaStructuredPrompt(event, opts),
      schema: agendaOutputSchema,
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    const agenda = unwrapAiResult(result);
    return { agenda, connectedIntegrations };
  }

  /**
   * The streamed prep. One paid call, the same context assembly, and the real
   * sources handed back beside the stream so the route can put them on the wire
   * before the body — a stream the user stops halfway still keeps its citations.
   */
  async streamAgenda(
    orgId: string,
    userId: string,
    rawEventId: string,
    opts: MeetingContextOptions,
    signal?: AbortSignal,
  ): Promise<AiTextStream & { sources: MeetingSource[] }> {
    const { event } = await this.loadPrepContext(orgId, userId, rawEventId);

    const stream = await this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "meetings.prep",
      prompt: agendaStreamPrompt(event, opts),
      maxTokens: 1024,
      charge: true,
      ...(signal !== undefined ? { signal } : {}),
    });

    return { ...stream, sources: agendaSources(event, opts) };
  }

  /**
   * Both representations of a follow-up start here, so they always describe the
   * same meeting. `loadEvent` filters on `orgId`, so another tenant's event is a
   * 404 rather than a 403 — a cross-tenant miss must not confirm the row exists.
   */
  private loadFollowUpEvent(orgId: string, rawEventId: string): Promise<MeetingEventContext> {
    const eventId = this.parseEventId(rawEventId);
    return runInTenantTransaction(this.db, (tx) => this.loadEvent(orgId, eventId, tx), { orgId });
  }

  async draftFollowUp(
    orgId: string,
    userId: string,
    rawEventId: string,
    meetingNotes: string | undefined,
    actionItems: string[] | undefined,
  ): Promise<{ followUp: FollowUpOutput; eventTitle: string }> {
    const event = await this.loadFollowUpEvent(orgId, rawEventId);

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "meetings.follow-up",
      prompt: followUpPrompt(event, meetingNotes, actionItems),
      schema: followUpOutputSchema,
      tier: "standard",
      maxTokens: 1024,
      charge: true,
    });

    const followUp = unwrapAiResult(result);
    return { followUp, eventTitle: event.title };
  }

  /**
   * The streamed follow-up. Same context, same feature key, same gateway, so it
   * is metered, breaker-guarded and concurrency-capped exactly as the buffered
   * sibling is — an unmetered streaming route would be a money leak. The signal
   * is the route's, so a client hang-up releases the reservation instead of
   * paying for tokens nobody will read.
   */
  async streamFollowUp(
    orgId: string,
    userId: string,
    rawEventId: string,
    meetingNotes: string | undefined,
    actionItems: string[] | undefined,
    signal?: AbortSignal,
  ): Promise<AiTextStream & { sources: MeetingSource[] }> {
    const event = await this.loadFollowUpEvent(orgId, rawEventId);

    const stream = await this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "meetings.follow-up",
      prompt: followUpStreamPrompt(event, meetingNotes, actionItems),
      maxTokens: 1024,
      charge: true,
      ...(signal !== undefined ? { signal } : {}),
    });

    return { ...stream, sources: followUpSources(event, meetingNotes, actionItems) };
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
