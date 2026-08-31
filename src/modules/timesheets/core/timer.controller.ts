import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { TimerService } from "./timer.service";
import {
  startTimerSchema,
  convertTimerSchema,
  type StartTimerInput,
  type ConvertTimerInput,
} from "./dto/timer.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const timerIdParams = z.object({ timerId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("timesheets/timer")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class TimerController {
  constructor(private readonly timer: TimerService) {}

  @Get("active")
  @RequirePermission("timesheets:entries:view")
  getActive(@CurrentUser() u: CurrentUserContext) {
    return this.timer.getActive(u);
  }

  @Post("start")
  @HttpCode(201)
  @RequirePermission("timesheets:entries:create")
  @Validate({ body: startTimerSchema })
  start(
    @Body() body: StartTimerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.startTimer(u, body);
  }

  @Post(":timerId/pause")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Validate({ params: timerIdParams })
  @BodylessAction()
  pause(
    @Param("timerId", ParseIntPipe) timerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.pauseTimer(u, timerId);
  }

  @Post(":timerId/resume")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Validate({ params: timerIdParams })
  @BodylessAction()
  resume(
    @Param("timerId", ParseIntPipe) timerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.resumeTimer(u, timerId);
  }

  @Post(":timerId/stop")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Validate({ params: timerIdParams })
  @BodylessAction()
  stop(
    @Param("timerId", ParseIntPipe) timerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.stopTimer(u, timerId);
  }

  @Post(":timerId/discard")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Validate({ params: timerIdParams })
  @BodylessAction()
  discard(
    @Param("timerId", ParseIntPipe) timerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.discardTimer(u, timerId);
  }

  @Post(":timerId/convert")
  @HttpCode(201)
  @RequirePermission("timesheets:entries:create")
  @Validate({ params: timerIdParams, body: convertTimerSchema })
  convert(
    @Param("timerId", ParseIntPipe) timerId: number,
    @Body() body: ConvertTimerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.convertTimer(u, timerId, body);
  }
}
