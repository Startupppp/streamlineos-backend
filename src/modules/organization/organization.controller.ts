import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OrganizationService } from "./organization.service";
import {
  cancelInvitationSchema,
  createOrganizationSchema,
  inviteMemberSchema,
  listMembersSchema,
  securitySettingsSchema,
  updateMemberRoleSchema,
  updateOrgSettingsSchema,
  type CancelInvitationInput,
  type CreateOrganizationInput,
  type InviteMemberInput,
  type ListMembersInput,
  type SecuritySettingsInput,
  type UpdateMemberRoleInput,
  type UpdateOrgSettingsInput,
} from "./dto/organization.schemas";

@Controller("organization")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Get()
  listOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listUserOrganizations(u.userId);
  }

  @Post()
  @HttpCode(201)
  createOrganization(
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      throw new ForbiddenException("Forbidden");
    }
    return this.organization.createOrganization(u.userId, body);
  }

  @Get("profile")
  async getProfile(@CurrentUser() u: CurrentUserContext) {
    const profile = await this.organization.getProfile(u.userId, u.orgId);
    if (!profile) throw new NotFoundException("User not found");
    return profile;
  }

  @Get("members")
  listMembers(
    @Query(new ZodValidationPipe(listMembersSchema)) query: ListMembersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.listMembers(u.orgId, query);
  }

  @Post("members")
  @HttpCode(201)
  @RequirePermission("settings:manage")
  inviteMember(
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.inviteMember(u.orgId, u.userId, body);
  }

  @Patch("members/:memberId")
  updateMemberRole(
    @Param("memberId") memberId: string,
    @Body(new ZodValidationPipe(updateMemberRoleSchema)) body: UpdateMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      throw new ForbiddenException("Forbidden");
    }
    return this.organization.updateMemberRole(u.orgId, u.userId, memberId, body.role);
  }

  @Delete("members/:memberId")
  removeMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext) {
    if (memberId === u.userId) {
      throw new BadRequestException("You cannot remove yourself from the organization");
    }
    const ability = defineAbilityFor(u);
    if (!ability.can("manage", "settings")) {
      throw new ForbiddenException("Forbidden");
    }
    return this.organization.removeMember(u.orgId, u.userId, memberId);
  }

  @Get("invitations")
  @RequirePermission("settings:manage")
  listInvitations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listInvitations(u.orgId);
  }

  @Delete("invitations")
  @RequirePermission("settings:manage")
  cancelInvitation(
    @Body(new ZodValidationPipe(cancelInvitationSchema)) body: CancelInvitationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.cancelInvitation(u.orgId, body.invitationId);
  }

  @Get("settings")
  async getSettings(@CurrentUser() u: CurrentUserContext) {
    const settings = await this.organization.getSettings(u.orgId);
    if (!settings) throw new NotFoundException("Organization not found");
    return settings;
  }

  @Patch("settings")
  updateSettings(
    @Body(new ZodValidationPipe(updateOrgSettingsSchema)) body: UpdateOrgSettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const ability = defineAbilityFor(u);
    if (!ability.can("manage", "settings")) {
      throw new ForbiddenException("Forbidden");
    }
    return this.organization.updateSettings(u.orgId, u.userId, body);
  }

  @Patch("security")
  @RequirePermission("settings:manage")
  updateSecuritySettings(
    @Body(new ZodValidationPipe(securitySettingsSchema)) body: SecuritySettingsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.organization.updateSecuritySettings(u.orgId, u.userId, body);
  }
}
