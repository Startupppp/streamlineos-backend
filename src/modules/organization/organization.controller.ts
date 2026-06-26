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
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { defineAbilityFor } from "../../common/rbac/abilities.factory";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { OrganizationService } from "./organization.service";
import {
  cancelInvitationSchema,
  createOrganizationSchema,
  listMembersSchema,
  type CancelInvitationInput,
  type CreateOrganizationInput,
  type ListMembersInput,
} from "./dto/organization.schemas";

@Controller("organization")
@UseGuards(JwtAuthGuard, AbilityGuard)
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Get()
  listOrganizations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listUserOrganizations(u.userId);
  }

  @Post()
  @HttpCode(201)
  @CheckAbility("manage", "all")
  createOrganization(
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
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
  @CheckAbility("manage", "settings")
  listInvitations(@CurrentUser() u: CurrentUserContext) {
    return this.organization.listInvitations(u.orgId);
  }

  @Delete("invitations")
  @CheckAbility("manage", "settings")
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
}
