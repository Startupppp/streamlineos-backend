import {
  Body,
  Controller,
  Param,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { OrgHierarchyService } from "./org-hierarchy.service";
import {
  moveOrgTeamSchema,
  moveBusinessUnitSchema,
  moveOrgBranchSchema,
  moveOrgDepartmentSchema,
  type MoveOrgTeamInput,
  type MoveBusinessUnitInput,
  type MoveOrgBranchInput,
  type MoveOrgDepartmentInput,
} from "./dto/org-hierarchy.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { hierarchyMoveResponseSchema } from "./dto/org-hierarchy-response.schemas";
import {
  businessUnitIdParams,
  branchIdParams,
  departmentIdParams,
  teamIdParams,
} from "./org-hierarchy-params";

@Controller("org-hierarchy")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrgHierarchyMovesController {
  constructor(private readonly service: OrgHierarchyService) {}

  @Patch("business-units/:businessUnitId/move")
  @ResponseSchema(hierarchyMoveResponseSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: businessUnitIdParams, body: moveBusinessUnitSchema })
  moveBusinessUnit(
    @Param("businessUnitId") businessUnitId: string,
    @Body() body: MoveBusinessUnitInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBusinessUnit(
      u.orgId,
      businessUnitId,
      body.parentId ?? null,
    );
  }

  @Patch("branches/:branchId/move")
  @ResponseSchema(hierarchyMoveResponseSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: branchIdParams, body: moveOrgBranchSchema })
  moveBranch(
    @Param("branchId") branchId: string,
    @Body() body: MoveOrgBranchInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveBranch(
      u.orgId,
      branchId,
      body.businessUnitId ?? null,
    );
  }

  @Patch("departments/:departmentId/move")
  @ResponseSchema(hierarchyMoveResponseSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: departmentIdParams, body: moveOrgDepartmentSchema })
  moveDepartment(
    @Param("departmentId") departmentId: string,
    @Body() body: MoveOrgDepartmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveDepartment(
      u.orgId,
      departmentId,
      body.branchId ?? null,
    );
  }

  @Patch("teams/:teamId/move")
  @ResponseSchema(hierarchyMoveResponseSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: teamIdParams, body: moveOrgTeamSchema })
  moveTeam(
    @Param("teamId") teamId: string,
    @Body() body: MoveOrgTeamInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.moveTeam(u.orgId, teamId, body.departmentId);
  }
}
