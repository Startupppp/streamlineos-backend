import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
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
import { HrTimelineService } from "./hr-timeline.service";
import { AccessService } from "../../access/access.service";
import { resolveEmployeesScope } from "../directory/employees-scope";
import { historyTypeSchema, listTimelineSchema, type HistoryTypeInput, type ListTimelineInput } from "./dto/hr-core.schemas";

@RequireModule("hr")
@Controller("hr/employees")
@UseGuards(JwtAuthGuard)
export class HrEmployeeSubroutesController {
  constructor(
    private readonly timeline: HrTimelineService,
    private readonly access: AccessService,
  ) {}

  @Get(":userId/employment")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  async getEmployment(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, u);
    return this.timeline.getEmploymentByUserId(u.orgId, u.userId, userId, scope);
  }

  @Get(":employeeId/timeline")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  async getTimeline(
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @Query(new ZodValidationPipe(listTimelineSchema)) query: ListTimelineInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, u);
    return this.timeline.getTimeline(u.orgId, u.userId, employeeId, scope, {
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(":employeeId/history")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  async getHistory(
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @Query(new ZodValidationPipe(historyTypeSchema)) query: HistoryTypeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, u);
    return this.timeline.getHistory(u.orgId, u.userId, employeeId, scope, query.type, {
      page: query.page,
      limit: query.limit,
    });
  }
}
