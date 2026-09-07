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
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  employmentRowSchema,
  employmentListPageSchema,
} from "./dto/core-response.schemas";

const employmentIdParams = z.object({ employmentId: z.coerce.number().int().positive() }).strict();

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
  @ResponseSchema(employmentListPageSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  @Validate({ query: listEmploymentsSchema })
  async list(
    @Query() query: ListEmploymentsInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.employeeRecordLists.listEmploymentsCursor(
      currentUser.orgId,
      currentUser.userId,
      { cursor: query.cursor, limit: query.limit },
      scope,
    );
  }

  @Get(":employmentId")
  @ResponseSchema(employmentRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  @Validate({ params: employmentIdParams })
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
  @ResponseSchema(employmentRowSchema)
  @Validate({ body: createEmploymentSchema })
  create(
    @Body() body: CreateEmploymentInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.employments.create(
      currentUser.orgId,
      currentUser.userId,
      body,
    );
  }

  @Patch(":employmentId")
  @ResponseSchema(employmentRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: employmentIdParams, body: updateEmploymentSchema })
  update(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @Body() body: UpdateEmploymentInput,
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
  @ResponseSchema(employmentRowSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @HttpCode(200)
  @Validate({ params: employmentIdParams, body: transitionStatusSchema })
  transition(
    @Param("employmentId", ParseIntPipe) employmentId: number,
    @Body() body: TransitionStatusInput,
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
  @NoContentResponse()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:manage")
  @Validate({ params: employmentIdParams })
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
