import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrEmploymentsService } from "./hr-employments.service";
import {
  createEmploymentSchema,
  paginationSchema,
  transitionStatusSchema,
  updateEmploymentSchema,
  type CreateEmploymentInput,
  type TransitionStatusInput,
  type UpdateEmploymentInput,
} from "./dto/hr-core.schemas";

@RequireModule("hr")
@Controller("hr/employments")
@UseGuards(JwtAuthGuard)
export class HrEmploymentsController {
  constructor(private readonly employments: HrEmploymentsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  list(
    @Query(new ZodValidationPipe(paginationSchema)) query: { page: number; limit: number },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.employments.list(u.orgId, { page: query.page, limit: query.limit });
  }

  @Get(":employmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:read")
  getOne(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.employments.getOne(u.orgId, employmentId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createEmploymentSchema)) body: CreateEmploymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.employments.create(u.orgId, u.userId, body);
  }

  @Patch(":employmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  update(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @Body(new ZodValidationPipe(updateEmploymentSchema)) body: UpdateEmploymentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.employments.update(u.orgId, employmentId, u.userId, body);
  }

  @Post(":employmentId/transition")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(200)
  transition(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @Body(new ZodValidationPipe(transitionStatusSchema)) body: TransitionStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.employments.transition(u.orgId, employmentId, u.userId, body);
  }

  @Delete(":employmentId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  remove(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.employments.remove(u.orgId, employmentId, u.userId);
  }
}
