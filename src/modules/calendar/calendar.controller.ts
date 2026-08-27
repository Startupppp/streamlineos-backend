import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CalendarService } from "./calendar.service";
import { ExternalCalendarEventsService } from "./external-calendar-events.service";
import { CalendarSourceRegistry } from "./calendar-source.registry";
import { CalendarSourcePreferencesService } from "./calendar-source-preferences.service";
import type { CalendarSourceContext } from "./calendar-event-source";
import {
  createEventSchema,
  exportSchema,
  externalEventsQuerySchema,
  listEventsSchema,
  rsvpSchema,
  updateEventSchema,
  type CreateEventInput,
  type ExportInput,
  type ExternalEventsQueryInput,
  type ListEventsInput,
  type RsvpInput,
  type UpdateEventInput,
} from "./dto/calendar.schemas";
import {
  setSourcePreferenceSchema,
  type SetSourcePreferenceInput,
} from "./dto/source-preference.schemas";
import {
  upsertOccurrenceExceptionSchema,
  type UpsertOccurrenceExceptionInput,
} from "./dto/occurrence-exception.schemas";

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDatetime(date: Date): string {
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

@Controller("calendar")
@UseGuards(JwtAuthGuard)
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly externalEvents: ExternalCalendarEventsService,
    private readonly registry: CalendarSourceRegistry,
    private readonly sourcePreferences: CalendarSourcePreferencesService,
  ) {}

  @Get("events")
  @Universal()
  getEvents(
    @Query(new ZodValidationPipe(listEventsSchema)) query: ListEventsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.calendar.getEvents(
      u.orgId,
      u.userId,
      new Date(query.start),
      new Date(query.end),
    );
  }

  @Get("external-events")
  @Universal()
  getExternalEvents(
    @Query(new ZodValidationPipe(externalEventsQuerySchema))
    query: ExternalEventsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.externalEvents.getExternalEvents(
      u.orgId,
      u.userId,
      query.start,
      query.end,
    );
  }

  @Post("events")
  @Universal()
  @HttpCode(201)
  createEvent(
    @Body(new ZodValidationPipe(createEventSchema)) body: CreateEventInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.calendar.createEvent(u.orgId, u.userId, body);
  }

  @Put("events/:eventId")
  @Universal()
  async updateEvent(
    @Param("eventId", ParseIntPipe) eventId: number,
    @Body(new ZodValidationPipe(updateEventSchema)) body: UpdateEventInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const event = await this.calendar.updateEvent(
      u.orgId,
      u.userId,
      eventId,
      body,
    );
    if (!event)
      throw new NotFoundException("Event not found or not authorized");
    return event;
  }

  @Delete("events/:eventId")
  @Universal()
  removeEvent(
    @Param("eventId", ParseIntPipe) eventId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.calendar.deleteEvent(u.orgId, u.userId, eventId);
  }

  @Post("events/:eventId/rsvp")
  @Universal()
  @HttpCode(200)
  async rsvp(
    @Param("eventId", ParseIntPipe) eventId: number,
    @Body(new ZodValidationPipe(rsvpSchema)) body: RsvpInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const attendee = await this.calendar.rsvp(u.orgId, u.userId, eventId, body);
    if (!attendee) throw new NotFoundException("Event not found");
    return attendee;
  }

  @Patch("events/:eventId/occurrences/:occurrenceStart")
  @Universal()
  @HttpCode(200)
  async upsertOccurrenceException(
    @Param("eventId", ParseIntPipe) eventId: number,
    @Param("occurrenceStart") occurrenceStart: string,
    @Body(new ZodValidationPipe(upsertOccurrenceExceptionSchema))
    body: UpsertOccurrenceExceptionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const row = await this.calendar.upsertOccurrenceException(
      u.orgId,
      u.userId,
      eventId,
      occurrenceStart,
      body,
    );
    if (!row) throw new NotFoundException("Event not found, not a recurring event, or not authorized");
    return row;
  }

  @Delete("events/:eventId/occurrences/:occurrenceStart")
  @Universal()
  @HttpCode(200)
  async cancelOccurrence(
    @Param("eventId", ParseIntPipe) eventId: number,
    @Param("occurrenceStart") occurrenceStart: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const row = await this.calendar.cancelOccurrence(
      u.orgId,
      u.userId,
      eventId,
      occurrenceStart,
    );
    if (!row) throw new NotFoundException("Event not found, not a recurring event, or not authorized");
    return row;
  }

  @Get("events/:eventId/rsvp")
  @UseGuards(PermissionGuard)
  @RequirePermission("calendar:read")
  async listAttendees(
    @Param("eventId", ParseIntPipe) eventId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const attendees = await this.calendar.listAttendees(u.orgId, eventId);
    if (!attendees) throw new NotFoundException("Event not found");
    return attendees;
  }

  @Get("export")
  @UseGuards(PermissionGuard)
  @RequirePermission("calendar:events:export")
  async exportEvents(
    @Query(new ZodValidationPipe(exportSchema)) query: ExportInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    const fromDate = new Date(query.from);
    const toDate = new Date(query.to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException("Invalid date format: use YYYY-MM-DD");
    }

    const events = await this.calendar.exportEvents(u.orgId, fromDate, toDate);

    const headers = [
      "Title",
      "Start",
      "End",
      "All Day",
      "Category",
      "Location",
      "Description",
      "Color",
    ];
    const rows = events.map((event) => [
      csvEscape(event.title),
      csvEscape(formatDatetime(event.startDate)),
      csvEscape(formatDatetime(event.endDate)),
      event.allDay ? "Yes" : "No",
      csvEscape(event.category ?? ""),
      csvEscape(event.location ?? ""),
      csvEscape(event.description ?? ""),
      csvEscape(event.color ?? ""),
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((r) => r.join(",")),
    ].join("\r\n");
    const filename = `calendar-${formatDate(fromDate)}-to-${formatDate(toDate)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(csvContent);
  }

  @Get("sources")
  @Universal()
  getSources(@CurrentUser() u: CurrentUserContext) {
    const now = new Date();
    const ctx: CalendarSourceContext = {
      orgId: u.orgId,
      userId: u.userId,
      start: now,
      end: now,
      scope: "all",
    };
    return this.registry.getToggleList(ctx);
  }

  @Put("sources/:sourceKey")
  @Universal()
  @HttpCode(200)
  async setSourcePreference(
    @Param("sourceKey") sourceKey: string,
    @Body(new ZodValidationPipe(setSourcePreferenceSchema)) body: SetSourcePreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.sourcePreferences.setPreference(u.orgId, u.userId, sourceKey, body.enabled);
    return { sourceKey, enabled: body.enabled };
  }
}
