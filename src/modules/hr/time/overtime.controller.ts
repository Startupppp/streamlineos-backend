import { Controller, Get, Post, Patch, Body, Param, ParseIntPipe, Query, UseGuards, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { OvertimeService } from "./overtime.service";
import { createOvertimeSchema, type CreateOvertimeInput } from "./dto/overtime.schemas";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const overtimeRequestIdParams = z.object({ overtimeRequestId: z.coerce.number().int().positive() }).strict();

const listQuerySchema = z.object({
  page: pageNumberField,
  pageSize: pageSizeField(20, 100),
});

@RequireModule("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller("hr/overtime")
export class OvertimeController {
  constructor(private readonly service: OvertimeService) {}

  @Get()
  @RequirePermission("hr:attendance:view")
  @Validate({ query: listQuerySchema })
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: z.infer<typeof listQuerySchema>,
  ) {
    return this.service.listRequests(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("hr:attendance:view")
  @Validate({ body: createOvertimeSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateOvertimeInput,
  ) {
    return this.service.createRequest(u.orgId, u.userId, body);
  }

  @Patch(":overtimeRequestId/approve")
  @Idempotent("hr.overtime.approve")
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: overtimeRequestIdParams })
  approve(
    @CurrentUser() u: CurrentUserContext,
    @Param("overtimeRequestId", ParseIntPipe) overtimeRequestId: number,
  ) {
    return this.service.approveRequest(u.orgId, overtimeRequestId, u.userId);
  }

  @Patch(":overtimeRequestId/reject")
  @BodylessAction()
  @Idempotent("hr.overtime.reject")
  @RequirePermission("hr:attendance:manage")
  @Validate({ params: overtimeRequestIdParams })
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
