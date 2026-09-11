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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { TimerService } from "./timer.service";
import {
  startTimerSchema,
  convertTimerSchema,
  type StartTimerInput,
  type ConvertTimerInput,
} from "./dto/timer.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";

const timerIdParams = z.object({ timerId: z.coerce.number().int().positive() }).strict();

/**
 * TS-17. Every timer write that creates something carries an optional fence.
 *
 * `start` and `convert` create rows; `stop` and `discard` end a session and a
 * duplicate of either is how a flaky connection produces two entries for one
 * afternoon. `pause` and `resume` are left alone on purpose — they set a state
 * that is already its own idempotent target, and a fence there would buy a
 * `command_fences` row per tap for nothing.
 *
 * Optional rather than required on all of them: see the note on
 * `EntriesController.create`.
 */
@RequireModule("timesheets")
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
  @Idempotent("timesheets.timer.start", { required: false })
  start(
    @Body() body: StartTimerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.startTimer(u, body);
  }

  @Post(":timerId/pause")
  @BodylessAction()
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
  @BodylessAction()
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
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Validate({ params: timerIdParams })
  @Idempotent("timesheets.timer.stop", { required: false })
  stop(
    @Param("timerId", ParseIntPipe) timerId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.stopTimer(u, timerId);
  }

  @Post(":timerId/discard")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("timesheets:entries:create")
  @Validate({ params: timerIdParams })
  @Idempotent("timesheets.timer.discard", { required: false })
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
  @Idempotent("timesheets.timer.convert", { required: false })
  convert(
    @Param("timerId", ParseIntPipe) timerId: number,
    @Body() body: ConvertTimerInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timer.convertTimer(u, timerId, body);
  }
}
