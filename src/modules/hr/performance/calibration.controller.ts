import { Controller, Get, Post, Body, Param, ParseIntPipe, UseGuards, Query, HttpCode } from "@nestjs/common";
import { CalibrationService } from "./calibration.service";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";

import {
  upsertCalibrationEntrySchema,
  type UpsertCalibrationEntryInput,
} from "./dto/calibration.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const cycleIdParams = z.object({ cycleId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/performance/calibration")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CalibrationController {
  constructor(private readonly calibrationService: CalibrationService) {}

  @Get("cycles/:cycleId/entries")
  @RequirePermission("hr:performance:manage")
  @Validate({ params: cycleIdParams })
  listEntries(
    @CurrentUser() user: CurrentUserContext,
    @Param("cycleId", ParseIntPipe) cycleId: number,
  ) {
    return this.calibrationService.listEntries(user.orgId, cycleId);
  }

  @Post("cycles/:cycleId/entries")
  @HttpCode(201)
  @RequirePermission("hr:performance:manage")
  @Validate({ params: cycleIdParams })
  upsertEntry(
    @CurrentUser() user: CurrentUserContext,
    @Param("cycleId", ParseIntPipe) cycleId: number,
    @Body(new ZodValidationPipe(upsertCalibrationEntrySchema)) body: UpsertCalibrationEntryInput,
  ) {
    return this.calibrationService.upsertEntry(
      user.orgId,
      cycleId,
      body.employeeId,
      { preRating: body.preRating, postRating: body.postRating, note: body.note },
      user.userId,
    );
  }

  @Get("nine-box")
  @RequirePermission("hr:performance:manage")
  getNineBox(
    @CurrentUser() user: CurrentUserContext,
    @Query("cycleId", ParseIntPipe) cycleId: number,
  ) {
    return this.calibrationService.getNineBox(user.orgId, cycleId);
  }
}
