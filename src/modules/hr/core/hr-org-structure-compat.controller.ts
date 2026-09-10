import {
  Body,
  Controller,
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
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import { orgLocationSchema, orgTeamSchema } from "./dto/core-response.schemas";

const locationIdParams = z.object({ locationId: z.string().min(1) }).strict();
const teamIdParams = z.object({ teamId: z.string().min(1) }).strict();

@Controller("hr/org")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrOrgStructureCompatController {
  constructor(private readonly catalog: HrOrgCatalogService) {}

  @Get("locations")
  @ResponseSchema(z.array(orgLocationSchema))
  @RequirePermission("settings:view")
  listLocations(@CurrentUser() user: CurrentUserContext) {
    return this.catalog.listLocations(user.orgId);
  }

  @Post("locations")
  @ResponseSchema(orgLocationSchema)
  @RequirePermission("settings:organization:manage")
  @HttpCode(201)
  @Validate({ body: createOrgLocationSchema })
  createLocation(
    @Body() body: CreateOrgLocationInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.createLocation(user.orgId, user.userId, body);
  }

  @Patch("locations/:locationId")
  @ResponseSchema(orgLocationSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: locationIdParams, body: updateOrgLocationSchema })
  updateLocation(
    @Param("locationId") locationId: string,
    @Body() body: UpdateOrgLocationInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.updateLocation(
      user.orgId,
      user.userId,
      locationId,
      body,
    );
  }

  @Get("teams")
  @ResponseSchema(z.array(orgTeamSchema))
  @RequirePermission("settings:view")
  listTeams(@CurrentUser() user: CurrentUserContext) {
    return this.catalog.listTeams(user.orgId);
  }

  @Post("teams")
  @ResponseSchema(orgTeamSchema)
  @RequirePermission("settings:organization:manage")
  @HttpCode(201)
  @Validate({ body: createOrgTeamSchema })
  createTeam(
    @Body() body: CreateOrgTeamInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.createTeam(user.orgId, user.userId, body);
  }

  @Patch("teams/:teamId")
  @ResponseSchema(orgTeamSchema)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: teamIdParams, body: updateOrgTeamSchema })
  updateTeam(
    @Param("teamId") teamId: string,
    @Body() body: UpdateOrgTeamInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.catalog.updateTeam(user.orgId, user.userId, teamId, body);
  }
}
