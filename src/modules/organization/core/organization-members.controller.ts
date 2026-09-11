import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  orgMembersListResponseSchema,
  updateMemberRoleResponseSchema,
  memberStatusMutationResponseSchema,
} from "./dto/organization-core-response.schemas";
import { OrgMembershipService } from "./org-membership.service";
import { OrgMembershipStatusService } from "./org-membership-status.service";
import { OrgMemberDepartureService } from "./org-member-departure.service";
import {
  listMembersSchema,
  updateMemberRoleSchema,
  type ListMembersInput,
  type UpdateMemberRoleInput,
} from "./dto/organization.schemas";
import { z } from "zod";

const memberIdParams = z.object({ memberId: z.string().min(1) }).strict();

@Controller("organization")
@UseGuards(JwtAuthGuard)
export class OrganizationMembersController {
  constructor(
    private readonly orgMembership: OrgMembershipService,
    private readonly orgMembershipStatus: OrgMembershipStatusService,
    private readonly orgMemberDeparture: OrgMemberDepartureService,
  ) {}

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:view")
  @Get("members")
  @ResponseSchema(orgMembersListResponseSchema)
  @Validate({ query: listMembersSchema })
  listMembers(
    @Query() query: ListMembersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgMembership.listMembers(u.orgId, query);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Patch("members/:memberId")
  @ResponseSchema(updateMemberRoleResponseSchema)
  @Validate({ params: memberIdParams, body: updateMemberRoleSchema })
  updateMemberRole(
    @Param("memberId") memberId: string,
    @Body() body: UpdateMemberRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.orgMembership.updateMemberRole(
      u.orgId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner },
      memberId,
      body.role,
    );
  }

  @Delete("members/:memberId")
  @NoContentResponse()
  @HttpCode(204)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: memberIdParams })
  async removeMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext): Promise<void> {
    if (memberId === u.userId)
      throw new BadRequestException("You cannot remove yourself from the organization");
    await this.orgMemberDeparture.removeMember(u.orgId, u.userId, memberId);
  }

  @Patch("members/:memberId/suspend")
  @BodylessAction()
  @ResponseSchema(memberStatusMutationResponseSchema)
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: memberIdParams })
  suspendMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext) {
    if (memberId === u.userId)
      throw new BadRequestException("You cannot suspend yourself");
    return this.orgMembershipStatus.suspendMember(u.orgId, u.userId, memberId);
  }

  @Patch("members/:memberId/reactivate")
  @BodylessAction()
  @ResponseSchema(memberStatusMutationResponseSchema)
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("settings:organization:manage")
  @Validate({ params: memberIdParams })
  reactivateMember(@Param("memberId") memberId: string, @CurrentUser() u: CurrentUserContext) {
    return this.orgMembershipStatus.reactivateMember(u.orgId, u.userId, memberId);
  }
}
