import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { PayrollComplianceService } from "./payroll-compliance.service";
import {
  createVarianceApprovalSchema,
  resolveVarianceSchema,
  listVarianceApprovalsSchema,
  createArrearsSchema,
  listArrearsSchema,
  createComplianceTaskSchema,
  updateComplianceTaskSchema,
  listComplianceTasksSchema,
  type CreateVarianceApprovalInput,
  type ResolveVarianceInput,
  type ListVarianceApprovalsInput,
  type CreateArrearsInput,
  type ListArrearsInput,
  type CreateComplianceTaskInput,
  type UpdateComplianceTaskInput,
  type ListComplianceTasksInput,
} from "./dto/enterprise-comp.schemas";
import { z } from "zod";
import { Validate } from "../../../common/validation/validate.decorator";

const seedPresetsSchema = z.object({ countryCode: z.string().length(2), periodKey: z.string().min(7) }).strict();
const varianceIdParams = z.object({ varianceId: z.coerce.number().int().positive() }).strict();
const arrearIdParams = z.object({ arrearId: z.coerce.number().int().positive() }).strict();
const taskIdParams = z.object({ taskId: z.coerce.number().int().positive() }).strict();


@RequireModule("hr")
@Controller("hr/enterprise/comp/payroll-compliance")
@UseGuards(JwtAuthGuard)
export class PayrollComplianceController {
  constructor(private readonly service: PayrollComplianceService) {}

  @Get("variance")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @Validate({ query: listVarianceApprovalsSchema })
  listVariance(
    @Query() query: ListVarianceApprovalsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listVarianceApprovals(u.orgId, query);
  }

  @Post("variance")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @HttpCode(201)
  @Validate({ body: createVarianceApprovalSchema })
  createVariance(
    @Body() body: CreateVarianceApprovalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createVarianceApproval(u.orgId, u.userId, body);
  }

  @Patch("variance/:varianceId/resolve")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @Validate({ params: varianceIdParams, body: resolveVarianceSchema })
  resolveVariance(
    @Param("varianceId", ParseIntPipe) varianceId: number,
    @Body() body: ResolveVarianceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.resolveVarianceApproval(u.orgId, varianceId, u.userId, body);
  }

  @Get("arrears")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @Validate({ query: listArrearsSchema })
  listArrears(
    @Query() query: ListArrearsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listArrears(u.orgId, query);
  }

  @Post("arrears")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @HttpCode(201)
  @Validate({ body: createArrearsSchema })
  createArrears(
    @Body() body: CreateArrearsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createArrears(u.orgId, u.userId, body);
  }

  @Patch("arrears/:arrearId/apply")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @Validate({ params: arrearIdParams })
  applyArrears(
    @Param("arrearId", ParseIntPipe) arrearId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.applyArrears(u.orgId, arrearId, u.userId);
  }

  @Get("tasks")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @Validate({ query: listComplianceTasksSchema })
  listTasks(
    @Query() query: ListComplianceTasksInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listComplianceTasks(u.orgId, query);
  }

  @Post("tasks")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @HttpCode(201)
  @Validate({ body: createComplianceTaskSchema })
  createTask(
    @Body() body: CreateComplianceTaskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createComplianceTask(u.orgId, u.userId, body);
  }

  @Patch("tasks/:taskId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @Validate({ params: taskIdParams, body: updateComplianceTaskSchema })
  updateTask(
    @Param("taskId", ParseIntPipe) taskId: number,
    @Body() body: UpdateComplianceTaskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateComplianceTask(u.orgId, taskId, u.userId, body);
  }

  @Post("tasks/seed-presets")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:payroll:manage")
  @HttpCode(200)
  @Validate({ body: seedPresetsSchema })
  seedPresets(
    @Body() body: { countryCode: string; periodKey: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.seedCountryPresets(u.orgId, u.userId, body.countryCode, body.periodKey);
  }
}
