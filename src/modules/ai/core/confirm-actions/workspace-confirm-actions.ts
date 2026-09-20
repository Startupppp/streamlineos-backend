import { BadRequestException } from "@nestjs/common";
import { CalendarService } from "../../../calendar/calendar.service";
import { EngagementService } from "../../../hr/performance/engagement.service";
import { BonusesService } from "../../../payroll/hr-payroll/bonuses.service";
import { createBonusSchema } from "../../../payroll/hr-payroll/dto/payroll.schemas";
import { resolveOrgTimezone } from "../services/ask-os-actor";
import { resolvePeopleByName } from "../../../directory/person-seam";
import {
  calendarEventPayloadSchema,
  calendarReminderPayloadSchema,
  grantBonusPayloadSchema,
  grantRecognitionPayloadSchema,
  scheduleMeetingPayloadSchema,
} from "../dto/confirm-action-payloads.schemas";
import { defineConfirmableAction } from "./confirmable-action.types";

export const WORKSPACE_CONFIRM_ACTIONS = [
  defineConfirmableAction({
    action: "calendar.createReminder",
    permission: "calendar:write",
    payload: calendarReminderPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(CalendarService, { strict: false }),
    execute: async (
      { title, startDate, endDate, timezone, description, fromTicketId },
      { actor, db },
      calendar,
    ) => {
      const { event } = await calendar.createEvent(actor.orgId, actor.userId, {
        title,
        startDate,
        endDate,
        timezone: timezone ?? (await resolveOrgTimezone(db, actor.orgId)),
        description,
        category: "reminder",
        color: "blue",
        ...(fromTicketId !== undefined && {
          entityType: "ticket",
          entityId: String(fromTicketId),
        }),
      });
      return {
        result: { eventId: event?.id, fromTicketId },
        summary: `Reminder created: ${title}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "calendar.createEvent",
    permission: "calendar:write",
    payload: calendarEventPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(CalendarService, { strict: false }),
    execute: async (
      { title, startDate, endDate, timezone, attendeeNames, location, description },
      { actor, db },
      calendar,
    ) => {
      const resolutions = await resolvePeopleByName(db, actor.orgId, attendeeNames ?? []);
      const attendeeIds: string[] = [];
      const problems: string[] = [];

      for (const [name, resolution] of resolutions) {
        if (resolution.status === "resolved") {
          attendeeIds.push(resolution.userId);
          continue;
        }
        if (resolution.status === "unresolved") {
          problems.push(`"${name}" matches nobody in this organization`);
          continue;
        }
        const candidates = resolution.candidates
          .map((candidate) =>
            candidate.hint === undefined
              ? candidate.label
              : `${candidate.label} (${candidate.hint})`,
          )
          .join(", ");
        problems.push(`"${name}" matches multiple people: ${candidates}`);
      }

      if (problems.length > 0)
        throw new BadRequestException(
          `The event was not created because some attendees could not be identified. ${problems.join("; ")}`,
        );

      const { event } = await calendar.createEvent(actor.orgId, actor.userId, {
        title,
        startDate,
        endDate,
        timezone,
        location,
        description,
        category: "general",
        attendeeIds,
      });
      return {
        result: { eventId: event?.id, location, attendeeCount: attendeeIds.length },
        summary: `Event created: ${title}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "calendar.scheduleMeeting",
    permission: "calendar:write",
    payload: scheduleMeetingPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(CalendarService, { strict: false }),
    execute: async (payload, { actor }, calendar) => {
      const { event } = await calendar.createEvent(actor.orgId, actor.userId, {
        title: payload.title,
        startDate: payload.startDate,
        endDate: payload.endDate,
        timezone: payload.timezone,
        attendeeIds: payload.attendeeIds,
        location: payload.location,
        description: payload.description,
        category: "meeting",
        color: "blue",
      });
      return {
        result: { eventId: event?.id, attendees: payload.attendeeIds.length },
        summary: `Meeting scheduled: ${payload.title}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "hr.grantRecognition",
    permission: "hr:engagement:manage",
    payload: grantRecognitionPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(EngagementService, { strict: false }),
    execute: async ({ toUserId, message, category }, { actor }, engagement) => {
      const recognition = await engagement.createRecognition(actor, {
        toUserId,
        message,
        category,
      });
      return { result: { recognitionId: recognition.id }, summary: `Recognition sent` };
    },
  }),

  defineConfirmableAction({
    action: "hr.grantBonus",
    permission: "hr:bonuses:manage",
    payload: grantBonusPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(BonusesService, { strict: false }),
    execute: async (payload, { actor }, bonuses) => {
      const input = createBonusSchema.parse({
        userId: payload.employeeId,
        type: payload.type,
        amount: payload.amount,
        reason: payload.reason,
        month: payload.month,
        taxable: payload.taxable,
      });
      const bonus = await bonuses.createBonus(actor.orgId, input);
      return {
        result: { bonusId: bonus.id, status: bonus.status, amount: bonus.amount },
        summary: `Bonus created (PENDING payroll approval): ${bonus.amount}`,
      };
    },
  }),
] as const;
