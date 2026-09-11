import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AttendanceRegularizationService } from "./attendance-regularization.service";
import { z } from "zod";
import {
  createAttendanceRegularizationSchema,
  listRegularizationsSchema,
  rejectRegularizationSchema,
  type CreateAttendanceRegularizationInput,
} from "./dto/attendance.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  regularizationRowSchema,
  regularizationListResponseSchema,
  regularizationApplyResponseSchema,
} from "./dto/time-attendance-response.schemas";

const regularizationIdParams = z.object({ regularizationId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/attendance/regularizations")
@UseGuards(JwtAuthGuard)
export class AttendanceRegularizationController {
  constructor(private readonly regularizationService: AttendanceRegularizationService) {}

  @Post()
  @HttpCode(201)
  @ResponseSchema(regularizationRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:regularize")
  @Validate({ body: createAttendanceRegularizationSchema })
  create(
    @Body() body: CreateAttendanceRegularizationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.regularizationService.create(u, body);
  }

  @Get()
  @ResponseSchema(regularizationListResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  @Validate({ query: listRegularizationsSchema })
  list(
    @Query() query: z.infer<typeof listRegularizationsSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.regularizationService.list(u, query);
  }

  @Post(":regularizationId/apply")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(regularizationApplyResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: regularizationIdParams })
  apply(
    @Param("regularizationId", ParseIntPipe) regularizationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.regularizationService.apply(u, regularizationId);
  }

  @Post(":regularizationId/reject")
  @Idempotent("hr.attendance-regularization.reject")
  @HttpCode(200)
  @ResponseSchema(successSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: regularizationIdParams, body: rejectRegularizationSchema })
  reject(
    @Param("regularizationId", ParseIntPipe) regularizationId: number,
    @Body() body: z.infer<typeof rejectRegularizationSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.regularizationService.reject(u, regularizationId, body.rejectionReason);
  }
}
