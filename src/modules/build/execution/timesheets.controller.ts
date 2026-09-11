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
  Res,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TimesheetsService } from "./timesheets.service";
import type { Response } from "express";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  billingSummaryQuerySchema,
  logTimeSchema,
  rejectEntrySchema,
  teamTimesheetsQuerySchema,
  timeEntriesListQuerySchema,
  timeEntryPaginationQuerySchema,
  type TimeEntryPaginationQuery,
  updateEntrySchema,
  type BillingSummaryQuery,
  type LogTimeInput,
  type RejectEntryInput,
  type TeamTimesheetsQuery,
  type TimeEntriesListQuery,
  type UpdateEntryInput,
} from "./dto/timesheets.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  timesheetEntrySchema,
  timesheetRowSchema,
  timesheetPageSchema,
  billingSummaryItemSchema,
} from "./dto/timesheets-response.schemas";
import { successSchema } from "../../../common/openapi/response-envelopes";

const entryIdParams = z.object({ entryId: z.coerce.number().int().positive() }).strict();
const projectAndTicketIdParams = z.object({ projectId: z.coerce.number().int().positive(), ticketId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/time-entries")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TimeEntriesController {
  constructor(private readonly timesheets: TimesheetsService) {}

  @Get()
  @RequirePermission("build:timesheets:view")
  @ResponseSchema(timesheetPageSchema)
  @Validate({ query: timeEntriesListQuerySchema })
  listTimeEntries(
    @Query() query: TimeEntriesListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.listTimeEntries(u, query);
  }

  @Get("team")
  @RequirePermission("build:timesheets:manage")
  @ResponseSchema(timesheetPageSchema)
  @Validate({ query: teamTimesheetsQuerySchema })
  teamTimesheets(
    @Query() query: TeamTimesheetsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.teamTimesheets(u, query);
  }

  @Patch(":entryId/approve")
  @BodylessAction()
  @Idempotent("build.timesheet.approve-entry")
  @RequirePermission("build:timesheets:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: entryIdParams })
  approveEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.approveEntry(u, entryId);
  }

  @Patch(":entryId/reject")
  @Idempotent("build.timesheet.reject-entry")
  @RequirePermission("build:timesheets:manage")
  @ResponseSchema(successSchema)
  @Validate({ params: entryIdParams, body: rejectEntrySchema })
  rejectEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body() body: RejectEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.rejectEntry(u, entryId, body);
  }

  @Patch(":entryId")
  @RequirePermission("build:timesheets:create")
  @ResponseSchema(timesheetRowSchema)
  @Validate({ params: entryIdParams, body: updateEntrySchema })
  updateEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @Body() body: UpdateEntryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.updateEntry(u, entryId, body);
  }

  @Delete(":entryId")
  @RequirePermission("build:timesheets:create")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: entryIdParams })
  deleteEntry(
    @Param("entryId", ParseIntPipe) entryId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.deleteEntry(u, entryId);
  }
}

@RequireModule("build")
@Controller("build/billing-summary")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BillingSummaryController {
  constructor(private readonly timesheets: TimesheetsService) {}

  @Get()
  @RequirePermission("build:timesheets:view")
  @ResponseSchema(z.array(billingSummaryItemSchema))
  @Validate({ query: billingSummaryQuerySchema })
  billingSummary(
    @Query() query: BillingSummaryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.billingSummary(u, query);
  }
}

@RequireModule("build")
@Controller("build/:projectId/tickets/:ticketId/time-entries")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TicketTimeEntriesController {
  constructor(private readonly timesheets: TimesheetsService) {}

  @Get()
  @RequirePermission("build:timesheets:view")
  @ResponseSchema(z.array(timesheetEntrySchema))
  @ApiOkResponse({ headers: {
    "Link": { description: "Relative next-page link when more entries exist", schema: { type: "string" } },
    "X-Next-Cursor": { description: "Opaque next-page cursor, empty on the final page", schema: { type: "string" } },
    "X-Has-More": { description: "Whether another page exists", schema: { type: "boolean" } },
  } })
  @Validate({ params: projectAndTicketIdParams, query: timeEntryPaginationQuerySchema })
  async listTicketTimeEntries(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Query() query: TimeEntryPaginationQuery,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const page = await this.timesheets.listTicketTimeEntries(u, projectId, ticketId, query);
    response.setHeader("Access-Control-Expose-Headers", "Link, X-Next-Cursor, X-Has-More");
    response.setHeader("X-Has-More", String(page.hasMore));
    response.setHeader("X-Next-Cursor", page.nextCursor ?? "");
    if (page.nextCursor)
      response.setHeader("Link", `</build/${projectId}/tickets/${ticketId}/time-entries?limit=${query.limit}&cursor=${encodeURIComponent(page.nextCursor)}>; rel="next"`);
    return page.items;
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("build:timesheets:create")
  @ResponseSchema(timesheetRowSchema)
  @Validate({ params: projectAndTicketIdParams, body: logTimeSchema })
  logTicketTime(
    @Param("ticketId", ParseIntPipe) ticketId: number,
    @Body() body: LogTimeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timesheets.logTicketTime(u, ticketId, body);
  }
}
