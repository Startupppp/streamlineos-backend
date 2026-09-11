import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  directoryListSchema,
  celebrationsResponseSchema,
  orgChartPageSchema,
  headcountGroupSchema,
  teamDetailSchema,
} from "./dto/directory-response.schemas";
import { z } from "zod";

const teamIdParams = z.object({ teamId: z.string().min(1) }).strict();

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
  @ResponseSchema(directoryListSchema)
  @RequirePermission("hr:employees:view")
  async directory(@CurrentUser() currentUser: CurrentUserContext) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    return this.orgStructure.getDirectory(read);
  }

  @Get("celebrations")
  @ResponseSchema(celebrationsResponseSchema)
  @RequirePermission("hr:employees:view")
  async celebrationsList(@CurrentUser() currentUser: CurrentUserContext) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    return this.celebrations.getCelebrations(read);
  }

  @Get("org-chart")
  @ResponseSchema(orgChartPageSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ query: orgChartQuerySchema })
  async orgChart(
    @Query() query: OrgChartQueryInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ): Promise<OrgChartPage> {
    const read = await resolveEmployeesScope(this.access, currentUser);
    return this.orgStructure.getOrgChart(read, query);
  }

  @Get("headcount")
  @ResponseSchema(headcountGroupSchema)
  @RequirePermission("hr:headcount:read")
  @Validate({ query: headcountSchema })
  headcount(
    @Query() query: HeadcountInput,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    return this.orgStructure.getHeadcount(currentUser.orgId, query);
  }

  @Get("teams/:teamId")
  @ResponseSchema(teamDetailSchema)
  @RequirePermission("hr:employees:view")
  @Validate({ params: teamIdParams })
  async team(
    @Param("teamId") teamId: string,
    @CurrentUser() currentUser: CurrentUserContext,
  ) {
    const read = await resolveEmployeesScope(this.access, currentUser);
    return this.orgStructure.getTeam(read, teamId);
  }
}
