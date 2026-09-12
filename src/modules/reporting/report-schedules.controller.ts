import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ReportSchedulesService } from "./report-schedules.service";
import {
  createScheduleSchema,
  updateScheduleSchema,
  type CreateScheduleInput,
  type UpdateScheduleInput,
} from "./dto/reporting.schemas";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  listReportSchedulesResponseSchema,
  reportScheduleResponseSchema,
  deleteReportScheduleResponseSchema,
} from "./dto/reporting-response.schemas";

/**
 * Reports that arrive without anybody asking.
 *
 * The keys follow the module's existing split rather than inventing a fourth.
 * Reading which reports are scheduled and where they go is `view`, the same
 * authority that reads the saved reports and the run log: it is the auditor's
 * question, and the answer contains no data. Creating, editing and deleting one
 * is `manage` — a schedule is shared, it decides what other people receive, and
 * it commits the organisation to running a query on a timetable.
 *
 * `run` is deliberately absent, and that is not an oversight. A schedule does
 * not run anything at the moment it is created; it names whose authority the
 * unattended run will carry, and that person's `run` key is checked by
 * `runDefinition` every time the schedule fires. Requiring `run` here as well
 * would say the author has to be able to run the report, which is a different
 * and weaker claim than the one the module actually enforces.
 *
 * The keys are spelled out as literals for the reason the controller beside
 * this one gives: `gated-keys-are-catalogued.spec.ts` finds gates by scanning
 * source for the decorator with a quoted argument, and a gate written against a
 * constant is one that spec cannot read.
 */
@RequireModule("crm")
@Controller("crm/reporting/schedules")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ReportSchedulesController {
  constructor(private readonly schedules: ReportSchedulesService) {}

  @Get()
  @RequirePermission("crm:reporting:view")
  @ResponseSchema(listReportSchedulesResponseSchema)
  list(@CurrentUser() u: CurrentUserContext) {
    return this.schedules.list(u.orgId);
  }

  @Get(":reportScheduleId")
  @RequirePermission("crm:reporting:view")
  @ResponseSchema(reportScheduleResponseSchema)
  get(
    @Param("reportScheduleId") reportScheduleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.schedules.get(u.orgId, reportScheduleId);
  }

  @Post()
  @RequirePermission("crm:reporting:manage")
  @ResponseSchema(reportScheduleResponseSchema)
  create(
    @Body(new ZodValidationPipe(createScheduleSchema)) body: CreateScheduleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.schedules.create(u.orgId, u.userId, body);
  }

  @Patch(":reportScheduleId")
  @RequirePermission("crm:reporting:manage")
  @ResponseSchema(reportScheduleResponseSchema)
  update(
    @Param("reportScheduleId") reportScheduleId: string,
    @Body(new ZodValidationPipe(updateScheduleSchema)) body: UpdateScheduleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.schedules.update(u.orgId, reportScheduleId, body);
  }

  @Delete(":reportScheduleId")
  @RequirePermission("crm:reporting:manage")
  @ResponseSchema(deleteReportScheduleResponseSchema)
  remove(
    @Param("reportScheduleId") reportScheduleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.schedules.remove(u.orgId, reportScheduleId);
  }
}
