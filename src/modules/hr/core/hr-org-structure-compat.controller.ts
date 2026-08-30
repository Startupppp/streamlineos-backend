import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import {
  createOrgLocationSchema,
  createOrgTeamSchema,
  updateOrgLocationSchema,
  updateOrgTeamSchema,
  type CreateOrgLocationInput,
  type CreateOrgTeamInput,
  type UpdateOrgLocationInput,
  type UpdateOrgTeamInput,
} from "../../organization/hierarchy/dto/org-hierarchy.schemas";
import { HrOrgCatalogService } from "./hr-org-catalog.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const locationIdParams = z.object({ locationId: z.string().min(1) }).strict();
const teamIdParams = z.object({ teamId: z.string().min(1) }).strict();

@Controller("hr/org")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrOrgStructureCompatController {
  constructor(private readonly catalog: HrOrgCatalogService) {}

  @Get("locations")
  @RequirePermission("settings:view")
  listLocations(@CurrentUser() user: CurrentUserContext) {
    return this.catalog.listLocations(user.orgId);
  }

  @Post("locations")
  @RequirePermission("settings:organization:manage")
  @HttpCode(201)
  createLocation(
    @Body(new ZodValidationPipe(createOrgLocationSchema))
    body: CreateOrgLocationInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.createLocation(user.orgId, user.userId, body);
  }

  @Patch("locations/:locationId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: locationIdParams })
  updateLocation(
    @Param("locationId") locationId: string,
    @Body(new ZodValidationPipe(updateOrgLocationSchema))
    body: UpdateOrgLocationInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.updateLocation(
      user.orgId,
      user.userId,
      locationId,
      body,
    );
  }

  @Delete("locations/:locationId")
  @HttpCode(204)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: locationIdParams })
  deleteLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.deleteLocation(user.orgId, user.userId, locationId);
  }

  @Get("teams")
  @RequirePermission("settings:view")
  listTeams(@CurrentUser() user: CurrentUserContext) {
    return this.catalog.listTeams(user.orgId);
  }

  @Post("teams")
  @RequirePermission("settings:organization:manage")
  @HttpCode(201)
  createTeam(
    @Body(new ZodValidationPipe(createOrgTeamSchema)) body: CreateOrgTeamInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.createTeam(user.orgId, user.userId, body);
  }

  @Patch("teams/:teamId")
  @RequirePermission("settings:organization:manage")
  @Validate({ params: teamIdParams })
  updateTeam(
    @Param("teamId") teamId: string,
    @Body(new ZodValidationPipe(updateOrgTeamSchema)) body: UpdateOrgTeamInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.updateTeam(user.orgId, user.userId, teamId, body);
  }

  @Delete("teams/:teamId")
  @HttpCode(204)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: teamIdParams })
  deleteTeam(
    @Param("teamId") teamId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.deleteTeam(user.orgId, user.userId, teamId);
  }
}
