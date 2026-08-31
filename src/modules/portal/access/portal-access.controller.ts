import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { PortalAccessService } from "./portal-access.service";
import {
  listMembershipsQuerySchema,
  createMembershipSchema,
  updateMembershipStatusSchema,
  listGrantsQuerySchema,
  createGrantSchema,
  updateGrantSchema,
  type ListMembershipsQuery,
  type CreateMembershipInput,
  type UpdateMembershipStatusInput,
  type ListGrantsQuery,
  type CreateGrantInput,
  type UpdateGrantInput,
} from "./dto/portal-access.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const portalMembershipIdParams = z.object({ portalMembershipId: z.string().min(1) }).strict();
const projectClientGrantIdParams = z.object({ projectClientGrantId: z.string().min(1) }).strict();

@RequireModule("build")
@Controller("portal-access")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PortalAccessController {
  constructor(private readonly svc: PortalAccessService) {}

  @Get("memberships")
  @RequirePermission("build:portal:view")
  @Validate({ query: listMembershipsQuerySchema })
  listMemberships(
    @Query() query: ListMembershipsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listMemberships(u.orgId, query);
  }

  @Post("memberships")
  @HttpCode(201)
  @RequirePermission("build:clientvisibility:manage")
  @Idempotent("portal.createMembership")
  @Validate({ body: createMembershipSchema })
  createMembership(
    @Body() body: CreateMembershipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createMembership(u.orgId, u.userId, body);
  }

  @Patch("memberships/:portalMembershipId/status")
  @RequirePermission("build:clientvisibility:manage")
  @Validate({ params: portalMembershipIdParams, body: updateMembershipStatusSchema })
  setMembershipStatus(
    @Param("portalMembershipId") portalMembershipId: string,
    @Body() body: UpdateMembershipStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setMembershipStatus(
      u.orgId,
      u.userId,
      portalMembershipId,
      body,
    );
  }

  @Get("grants")
  @RequirePermission("build:portal:view")
  @Validate({ query: listGrantsQuerySchema })
  listGrants(
    @Query() query: ListGrantsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listGrants(u.orgId, query);
  }

  @Post("grants")
  @HttpCode(201)
  @RequirePermission("build:clientvisibility:manage")
  @Idempotent("portal.createGrant")
  @Validate({ body: createGrantSchema })
  createGrant(
    @Body() body: CreateGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createGrant(u.orgId, u.userId, body);
  }

  @Patch("grants/:projectClientGrantId")
  @RequirePermission("build:clientvisibility:manage")
  @Validate({ params: projectClientGrantIdParams, body: updateGrantSchema })
  updateGrant(
    @Param("projectClientGrantId") projectClientGrantId: string,
    @Body() body: UpdateGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateGrant(u.orgId, u.userId, projectClientGrantId, body);
  }

  @Post("grants/:projectClientGrantId/revoke")
  @HttpCode(200)
  @RequirePermission("build:clientvisibility:manage")
  @Validate({ params: projectClientGrantIdParams })
  @BodylessAction()
  revokeGrant(
    @Param("projectClientGrantId") projectClientGrantId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.revokeGrant(u.orgId, u.userId, projectClientGrantId);
  }
}
