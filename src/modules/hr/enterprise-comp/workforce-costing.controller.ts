import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { WorkforceCostingService } from "./workforce-costing.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts"
import { costSummaryResponseSchema, costByDepartmentResponseSchema, costByLocationResponseSchema, forecastedCostResponseSchema } from "./dto/enterprise-comp-response.schemas"

const costByDeptSchema = z.object({ periodKey: z.string().min(7) });
const forecastedCostQuerySchema = z.object({ cycleId: z.coerce.number().int().positive() });

@RequireModule("hr")
@Controller("hr/enterprise/comp/costing")
@UseGuards(JwtAuthGuard)
export class WorkforceCostingController {
  constructor(private readonly service: WorkforceCostingService) {}

  @ResponseSchema(costSummaryResponseSchema)
  @Get("summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  summary(@CurrentUser() u: CurrentUserContext) {
    return this.service.costSummary(u.orgId);
  }

  @ResponseSchema(costByDepartmentResponseSchema)
  @Get("by-department")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  @Validate({ query: costByDeptSchema })
  byDepartment(
    @Query() query: z.infer<typeof costByDeptSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.costByDepartment(u.orgId, query.periodKey);
  }

  @ResponseSchema(costByLocationResponseSchema)
  @Get("by-location")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:analytics:read")
  byLocation(@CurrentUser() u: CurrentUserContext) {
    return this.service.costByLocation(u.orgId);
  }

  @ResponseSchema(forecastedCostResponseSchema)
  @Get("forecasted")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:salary:view")
  @Validate({ query: forecastedCostQuerySchema })
  forecasted(
    @Query() query: z.infer<typeof forecastedCostQuerySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.forecastedCost(u.orgId, query.cycleId);
  }
}
