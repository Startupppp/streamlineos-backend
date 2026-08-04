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
import { historyTypeSchema, listTimelineSchema, type HistoryTypeInput, type ListTimelineInput } from "./dto/hr-core.schemas";

@RequireModule("hr")
@Controller("hr/employees")
@UseGuards(JwtAuthGuard)
export class HrEmployeeSubroutesController {
  constructor(private readonly timeline: HrTimelineService) {}

  @Get(":userId/employment")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  getEmployment(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timeline.getEmploymentByUserId(u.orgId, userId);
  }

  @Get(":employeeId/timeline")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  getTimeline(
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @Query(new ZodValidationPipe(listTimelineSchema)) query: ListTimelineInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timeline.getTimeline(u.orgId, employeeId, { page: query.page, limit: query.limit });
  }

  @Get(":employeeId/history")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:employees:view")
  getHistory(
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @Query(new ZodValidationPipe(historyTypeSchema)) query: HistoryTypeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timeline.getHistory(u.orgId, employeeId, query.type, {
      page: query.page,
      limit: query.limit,
    });
  }
}
