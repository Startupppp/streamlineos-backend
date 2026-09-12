import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PeriodsService } from "./periods.service";
import { TimesheetOverdueService } from "./overdue.service";
import { periodsQuerySchema, type PeriodsQuery } from "./dto/periods.schemas";
import { overdueQuerySchema, type OverdueQuery } from "./dto/overdue.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";
import {
  periodsListResponseSchema,
  timesheetPeriodSchema,
  periodDetailResponseSchema,
  overdueQueueResponseSchema,
} from "./dto/timesheets-response.schemas";

const periodIdParams = z.object({ periodId: z.coerce.number().int().positive() }).strict();

@RequireModule("timesheets")
@Controller("timesheets/periods")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimesheetPeriodsController {
  constructor(
    private readonly periods: PeriodsService,
    private readonly overdue: TimesheetOverdueService,
  ) {}

  @Get()
  @RequirePermission("timesheets:entries:view")
  @Validate({ query: periodsQuerySchema })
  @ResponseSchema(periodsListResponseSchema)
  list(
    @Query() query: PeriodsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.listPeriods(u, query);
  }

  @Get("current")
  @RequirePermission("timesheets:entries:view")
  @ResponseSchema(periodDetailResponseSchema)
  getCurrent(@CurrentUser() u: CurrentUserContext) {
    return this.periods.getCurrent(u);
  }

  /**
   * TS-11. Declared before `:periodId` because Nest matches in declaration
   * order: below it, `GET /timesheets/periods/overdue` would reach the handler
   * with the `ParseIntPipe` and 400 on the word "overdue".
   *
   * `timesheets:approvals:view` rather than a new key. The queue lists other
   * people's late timesheets, which is precisely the standing the approvals
   * queue already grants, and the same `DataScope` narrows it — a `team`
   * approver sees their team, not the organisation.
   */
  @Get("overdue")
  @RequirePermission("timesheets:approvals:view")
  @Validate({ query: overdueQuerySchema })
  @ResponseSchema(overdueQueueResponseSchema)
  listOverdue(
    @Query() query: OverdueQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.overdue.listOverdue(u, query);
  }

  @Get(":periodId")
  @RequirePermission("timesheets:entries:view")
  @Validate({ params: periodIdParams })
  @ResponseSchema(periodDetailResponseSchema)
  getPeriod(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.getPeriod(u, periodId);
  }

  @Post(":periodId/submit")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Idempotent("timesheets.period.submit")
  @Validate({ params: periodIdParams })
  @ResponseSchema(timesheetPeriodSchema)
  submit(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.submitPeriod(u, periodId);
  }

  @Post(":periodId/recall")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Validate({ params: periodIdParams })
  @ResponseSchema(timesheetPeriodSchema)
  recall(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.recallPeriod(u, periodId);
  }

  @Post(":periodId/reopen")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  @Validate({ params: periodIdParams })
  @ResponseSchema(timesheetPeriodSchema)
  reopen(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.reopenPeriod(u, periodId);
  }

  @Post(":periodId/lock")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  @Validate({ params: periodIdParams })
  @ResponseSchema(timesheetPeriodSchema)
  lock(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.lockPeriod(u, periodId);
  }

  @Post(":periodId/unlock")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("timesheets:approvals:manage")
  @Validate({ params: periodIdParams })
  @ResponseSchema(timesheetPeriodSchema)
  unlock(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.unlockPeriod(u, periodId);
  }
}
