import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OvertimeService } from "./overtime.service";
import { createOvertimeSchema, type CreateOvertimeInput } from "./dto/overtime.schemas";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/overtime")
export class OvertimeController {
  constructor(private readonly service: OvertimeService) {}

  @Get()
  @RequirePermission("hr:attendance:view")
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ) {
    return this.service.listRequests(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:attendance:view")
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(createOvertimeSchema)) body: CreateOvertimeInput,
  ) {
    return this.service.createRequest(u.orgId, u.userId, body);
  }

  @Patch(":overtimeRequestId/approve")
  @RequirePermission("hr:attendance:manage")
  approve(
    @CurrentUser() u: CurrentUserContext,
    @Param("overtimeRequestId", ParseIntPipe) overtimeRequestId: number,
  ) {
    return this.service.approveRequest(u.orgId, overtimeRequestId, u.userId);
  }

  @Patch(":overtimeRequestId/reject")
  @RequirePermission("hr:attendance:manage")
  reject(
    @CurrentUser() u: CurrentUserContext,
    @Param("overtimeRequestId", ParseIntPipe) overtimeRequestId: number,
  ) {
    return this.service.rejectRequest(u.orgId, overtimeRequestId, u.userId);
  }

  @Get("comp-off")
  @RequirePermission("hr:attendance:view")
  getCompOff(@CurrentUser() u: CurrentUserContext) {
    return this.service.getCompOffBalance(u.orgId, u.userId);
  }
}
