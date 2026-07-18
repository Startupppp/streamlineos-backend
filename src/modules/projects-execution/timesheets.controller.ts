import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { TimesheetsService } from "./timesheets.service";
import {
  billingSummaryQuerySchema,
  logTimeSchema,
  rejectEntrySchema,
  teamTimesheetsQuerySchema,
  timeEntriesListQuerySchema,
  updateEntrySchema,
  type BillingSummaryQuery,
  type LogTimeInput,
  type RejectEntryInput,
  type TeamTimesheetsQuery,
  type TimeEntriesListQuery,
  type UpdateEntryInput,
} from "./dto/timesheets.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("projects")
@Controller("projects/time-entries")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TimeEntriesController {
  constructor(private readonly timesheets: TimesheetsService) {}

  @Get()
  @RequirePermission("projects:timesheets:view")
  listTimeEntries(
    @Query(new ZodValidationPipe(timeEntriesListQuerySchema)) query: TimeEntriesListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.listTimeEntries(u, query);
  }

  @Get("team")
  @RequirePermission("projects:timesheets:manage")
  teamTimesheets(
    @Query(new ZodValidationPipe(teamTimesheetsQuerySchema)) query: TeamTimesheetsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.teamTimesheets(u, query);
  }

  @Patch(":entryId/approve")
  @RequirePermission("projects:timesheets:manage")
  approveEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.approveEntry(u, entryId);
  }

  @Patch(":entryId/reject")
  @RequirePermission("projects:timesheets:manage")
  rejectEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body(new ZodValidationPipe(rejectEntrySchema)) body: RejectEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.rejectEntry(u, entryId, body);
  }

  @Patch(":entryId")
  @RequirePermission("projects:timesheets:create")
  updateEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body(new ZodValidationPipe(updateEntrySchema)) body: UpdateEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.updateEntry(u, entryId, body);
  }

  @Delete(":entryId")
  @RequirePermission("projects:timesheets:create")
  @HttpCode(204)
  deleteEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.deleteEntry(u, entryId);
  }
}

@RequireModule("projects")
@Controller("projects/billing-summary")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BillingSummaryController {
  constructor(private readonly timesheets: TimesheetsService) {}

  @Get()
  @RequirePermission("projects:view")
  billingSummary(
    @Query(new ZodValidationPipe(billingSummaryQuerySchema)) query: BillingSummaryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.billingSummary(u, query);
  }
}

@RequireModule("projects")
@Controller("projects/:projectId/tickets/:ticketId/time-entries")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TicketTimeEntriesController {
  constructor(private readonly timesheets: TimesheetsService) {}

  @Get()
  @RequirePermission("projects:timesheets:view")
  listTicketTimeEntries(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.listTicketTimeEntries(u.orgId, ticketId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("projects:timesheets:create")
  logTicketTime(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(logTimeSchema)) body: LogTimeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.logTicketTime(u, ticketId, body);
  }
}
