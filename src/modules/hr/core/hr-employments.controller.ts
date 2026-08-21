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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { HrEmploymentsService } from "./hr-employments.service";
import { HrEmployeeRecordListsService } from "./hr-employee-record-lists.service";
import { AccessService } from "../../access/access.service";
import { resolveEmployeesScope } from "../directory/employees-scope";
import {
  createEmploymentSchema,
  listEmploymentsSchema,
  transitionStatusSchema,
  updateEmploymentSchema,
  type CreateEmploymentInput,
  type ListEmploymentsInput,
  type TransitionStatusInput,
  type UpdateEmploymentInput,
} from "./dto/hr-core.schemas";

@RequireModule("hr")
@Controller("hr/employments")
@UseGuards(JwtAuthGuard)
export class HrEmploymentsController {
  constructor(
    private readonly employments: HrEmploymentsService,
    private readonly employeeRecordLists: HrEmployeeRecordListsService,
    private readonly access: AccessService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  async list(
    @Query(new ZodValidationPipe(listEmploymentsSchema)) query: ListEmploymentsInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    if (query.page !== undefined) {
      return this.employeeRecordLists.listEmploymentsPage(
        currentUser.orgId,
        currentUser.userId,
        { page: query.page, limit: query.limit },
        scope,
      );
    }
    return this.employeeRecordLists.listEmploymentsCursor(
      currentUser.orgId,
      currentUser.userId,
      { cursor: query.cursor, limit: query.limit },
      scope,
    );
  }

  @Get(":employmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  async getOne(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.employments.getOne(
      currentUser.orgId,
      currentUser.userId,
      employmentId,
      scope,
    );
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createEmploymentSchema)) body: CreateEmploymentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employments.create(
      currentUser.orgId,
      currentUser.userId,
      body,
    );
  }

  @Patch(":employmentId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  update(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @Body(new ZodValidationPipe(updateEmploymentSchema)) body: UpdateEmploymentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employments.update(
      currentUser.orgId,
      employmentId,
      currentUser.userId,
      body,
    );
  }

  @Post(":employmentId/transition")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(200)
  transition(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @Body(new ZodValidationPipe(transitionStatusSchema)) body: TransitionStatusInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employments.transition(
      currentUser.orgId,
      employmentId,
      currentUser.userId,
      body,
    );
  }

  @Delete(":employmentId")
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  remove(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employments.remove(
      currentUser.orgId,
      employmentId,
      currentUser.userId,
    );
  }
}
