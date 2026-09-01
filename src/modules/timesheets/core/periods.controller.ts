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
import { periodsQuerySchema, type PeriodsQuery } from "./dto/periods.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const periodIdParams = z.object({ periodId: z.coerce.number().int().positive() }).strict();

@RequireModule("timesheets")
@Controller("timesheets/periods")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimesheetPeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  @RequirePermission("timesheets:entries:view")
  @Validate({ query: periodsQuerySchema })
  list(
    @Query() query: PeriodsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.listPeriods(u, query);
  }

  @Get("current")
  @RequirePermission("timesheets:entries:view")
  getCurrent(@CurrentUser() u: CurrentUserContext) {
    return this.periods.getCurrent(u);
  }

  @Get(":periodId")
  @RequirePermission("timesheets:entries:view")
  @Validate({ params: periodIdParams })
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
  unlock(
    @Param("periodId", ParseIntPipe) periodId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.periods.unlockPeriod(u, periodId);
  }
}
