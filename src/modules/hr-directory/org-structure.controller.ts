import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OrgStructureService } from "./org-structure.service";
import { CelebrationsService } from "./celebrations.service";
import { headcountSchema, type HeadcountInput } from "./dto/hr-directory.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrgStructureController {
  constructor(
    private readonly orgStructure: OrgStructureService,
    private readonly celebrations: CelebrationsService,
  ) {}

  @Get("directory")
  @RequirePermission("hr:employees:view")
  directory(@CurrentUser() u: CurrentUserContext) {
    return this.orgStructure.getDirectory(u.orgId);
  }

  @Get("celebrations")
  @RequirePermission("hr:employees:view")
  celebrationsList(@CurrentUser() u: CurrentUserContext) {
    return this.celebrations.getCelebrations(u.orgId);
  }

  @Get("org-chart")
  @RequirePermission("hr:employees:view")
  orgChart(@CurrentUser() u: CurrentUserContext) {
    return this.orgStructure.getOrgChart(u.orgId);
  }

  @Get("headcount")
  @RequirePermission("hr:headcount:read")
  headcount(
    @Query(new ZodValidationPipe(headcountSchema)) query: HeadcountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgStructure.getHeadcount(u.orgId, query);
  }

  @Get("teams/:teamId")
  @RequirePermission("hr:employees:view")
  team(@Param("teamId") teamId: string, @CurrentUser() u: CurrentUserContext) {
    return this.orgStructure.getTeam(u.orgId, teamId);
  }
}
