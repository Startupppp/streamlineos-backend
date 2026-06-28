import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrDepartmentsService } from "./hr-departments.service";
import { createDepartmentSchema, type CreateDepartmentInput } from "./dto/departments.schemas";

@Controller("hr/departments")
@UseGuards(JwtAuthGuard)
export class HrDepartmentsController {
  constructor(private readonly departments: HrDepartmentsService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.departments.list(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createDepartmentSchema)) body: CreateDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.departments.create(u.orgId, body.name);
  }
}
