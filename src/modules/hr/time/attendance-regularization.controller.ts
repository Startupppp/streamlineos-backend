import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AttendanceRegularizationService } from "./attendance-regularization.service";
import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";
import {
  createAttendanceRegularizationSchema,
  type CreateAttendanceRegularizationInput,
} from "./dto/attendance.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";

const regularizationIdParams = z.object({ regularizationId: z.coerce.number().int().positive() }).strict();

const listRegularizationsSchema = z.object({
  userId: z.string().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: pageNumberField,
  limit: pageSizeField(20, 100),
});

const rejectRegularizationSchema = z.object({
  rejectionReason: z.string().min(1).max(500),
});

@RequireModule("hr")
@Controller("hr/attendance/regularizations")
@UseGuards(JwtAuthGuard)
export class AttendanceRegularizationController {
  constructor(private readonly regularizationService: AttendanceRegularizationService) {}

  @Post()
  @HttpCode(201)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:regularize")
  create(
    @Body(new ZodValidationPipe(createAttendanceRegularizationSchema))
    body: CreateAttendanceRegularizationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.regularizationService.create(u, body);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:view")
  list(
    @Query(new ZodValidationPipe(listRegularizationsSchema)) query: z.infer<typeof listRegularizationsSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.regularizationService.list(u, query);
  }

  @Post(":regularizationId/apply")
  @HttpCode(200)
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
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: regularizationIdParams })
  reject(
    @Param("regularizationId", ParseIntPipe) regularizationId: number,
    @Body(new ZodValidationPipe(rejectRegularizationSchema)) body: z.infer<typeof rejectRegularizationSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.regularizationService.reject(u, regularizationId, body.rejectionReason);
  }
}
