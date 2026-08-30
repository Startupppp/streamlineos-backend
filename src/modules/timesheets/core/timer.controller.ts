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
import { z } from "zod";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { Validate } from "../../../common/validation/validate.decorator";
import { TimerService } from "./timer.service";
import {
  startTimerSchema,
  convertTimerSchema,
  type StartTimerInput,
  type ConvertTimerInput,
} from "./dto/timer.schemas";

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
  start(
    @Body(new ZodValidationPipe(startTimerSchema)) body: StartTimerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.startTimer(u, body);
  }

  @Post(":timerId/pause")
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Validate({ params: timerIdParams })
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
  discard(
    @Param("timerId", ParseIntPipe) timerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.discardTimer(u, timerId);
  }

  @Post(":timerId/convert")
  @HttpCode(201)
  @RequirePermission("timesheets:entries:create")
  convert(
    @Param("timerId", ParseIntPipe) timerId: number,
    @Body(new ZodValidationPipe(convertTimerSchema)) body: ConvertTimerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.convertTimer(u, timerId, body);
  }
}
