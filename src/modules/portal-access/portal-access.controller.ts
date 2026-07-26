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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
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

@RequireModule("projects")
@Controller("portal-access")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class PortalAccessController {
  constructor(private readonly svc: PortalAccessService) {}

  @Get("memberships")
  @RequirePermission("projects:portal:view")
  listMemberships(
    @Query(new ZodValidationPipe(listMembershipsQuerySchema)) query: ListMembershipsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listMemberships(u.orgId, query);
  }

  @Post("memberships")
  @HttpCode(201)
  @RequirePermission("projects:clientvisibility:manage")
  @Idempotent("portal.createMembership")
  createMembership(
    @Body(new ZodValidationPipe(createMembershipSchema)) body: CreateMembershipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createMembership(u.orgId, u.userId, body);
  }

  @Patch("memberships/:portalMembershipId/status")
  @RequirePermission("projects:clientvisibility:manage")
  setMembershipStatus(
    @Param("portalMembershipId") portalMembershipId: string,
    @Body(new ZodValidationPipe(updateMembershipStatusSchema)) body: UpdateMembershipStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.setMembershipStatus(u.orgId, u.userId, portalMembershipId, body);
  }

  @Get("grants")
  @RequirePermission("projects:portal:view")
  listGrants(
    @Query(new ZodValidationPipe(listGrantsQuerySchema)) query: ListGrantsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listGrants(u.orgId, query);
  }

  @Post("grants")
  @HttpCode(201)
  @RequirePermission("projects:clientvisibility:manage")
  @Idempotent("portal.createGrant")
  createGrant(
    @Body(new ZodValidationPipe(createGrantSchema)) body: CreateGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createGrant(u.orgId, u.userId, body);
  }

  @Patch("grants/:projectClientGrantId")
  @RequirePermission("projects:clientvisibility:manage")
  updateGrant(
    @Param("projectClientGrantId") projectClientGrantId: string,
    @Body(new ZodValidationPipe(updateGrantSchema)) body: UpdateGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateGrant(u.orgId, u.userId, projectClientGrantId, body);
  }

  @Post("grants/:projectClientGrantId/revoke")
  @HttpCode(200)
  @RequirePermission("projects:clientvisibility:manage")
  revokeGrant(
    @Param("projectClientGrantId") projectClientGrantId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.revokeGrant(u.orgId, u.userId, projectClientGrantId);
  }
}
