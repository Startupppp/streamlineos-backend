import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import {
  OrgStructureService,
  type OrgChartPage,
} from "./org-structure.service";
import { CelebrationsService } from "./celebrations.service";
import {
  headcountSchema,
  orgChartQuerySchema,
  type HeadcountInput,
  type OrgChartQueryInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { AccessService } from "../../access/access.service";
import { resolveEmployeesScope } from "./employees-scope";

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrgStructureController {
  constructor(
    private readonly orgStructure: OrgStructureService,
    private readonly celebrations: CelebrationsService,
    private readonly access: AccessService,
  ) {}

  @Get("directory")
  @RequirePermission("hr:employees:view")
  async directory(@CurrentUser() currentUser: CurrentUserContext) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.orgStructure.getDirectory(currentUser.orgId, currentUser.userId, scope);
  }

  @Get("celebrations")
  @RequirePermission("hr:employees:view")
  async celebrationsList(@CurrentUser() currentUser: CurrentUserContext) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.celebrations.getCelebrations(currentUser.orgId, currentUser.userId, scope);
  }

  @Get("org-chart")
  @RequirePermission("hr:employees:view")
  async orgChart(
    @Query(new ZodValidationPipe(orgChartQuerySchema)) query: OrgChartQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ): Promise<OrgChartPage> {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.orgStructure.getOrgChart(currentUser.orgId, currentUser.userId, scope, query);
  }

  @Get("headcount")
  @RequirePermission("hr:headcount:read")
  headcount(
    @Query(new ZodValidationPipe(headcountSchema)) query: HeadcountInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.orgStructure.getHeadcount(currentUser.orgId, query);
  }

  @Get("teams/:teamId")
  @RequirePermission("hr:employees:view")
  async team(
    @Param("teamId") teamId: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const scope = await resolveEmployeesScope(this.access, currentUser);
    return this.orgStructure.getTeam(currentUser.orgId, currentUser.userId, teamId, scope);
  }
}
