import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { PartyMergeService } from "./party-merge.service";
import { PartyRolesService } from "./party-roles.service";

/**
 * Roles a party holds, duplicates the system found, and merges.
 *
 * Separate from the party controller because these are administration of the
 * record set rather than of a record, and they carry their own permissions: a
 * user who may edit a party should not necessarily be able to fuse two of them.
 */
@Controller("party")
@UseGuards(JwtAuthGuard)
export class PartyMergeController {
  constructor(
    private readonly roles: PartyRolesService,
    private readonly merges: PartyMergeService,
  ) {}

  @Get("parties/:partyId/roles")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:parties:view")
  async listRoles(@CurrentUser() user: CurrentUserContext, @Param("partyId") partyId: string) {
    return { roles: await this.roles.listRoles(user.orgId, partyId) };
  }

  @Post("parties/:partyId/roles")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:roles:manage")
  @Idempotent("party.role.add")
  async addRole(
    @CurrentUser() user: CurrentUserContext,
    @Param("partyId") partyId: string,
    @Body() body: { role: string },
  ) {
    return { roles: await this.roles.addRole(user.orgId, partyId, body.role, user.userId) };
  }

  @Delete("parties/:partyId/roles/:role")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:roles:manage")
  async removeRole(
    @CurrentUser() user: CurrentUserContext,
    @Param("partyId") partyId: string,
    @Param("role") role: string,
  ) {
    return { roles: await this.roles.removeRole(user.orgId, partyId, role, user.userId) };
  }

  @Post("parties/:partyId/detect-duplicates")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:merges:manage")
  @Idempotent("party.duplicates.detect")
  async detect(@CurrentUser() user: CurrentUserContext, @Param("partyId") partyId: string) {
    return this.roles.detectFor(user.orgId, partyId, user.userId);
  }

  @Get("duplicates")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:duplicates:view")
  async listCandidates(
    @CurrentUser() user: CurrentUserContext,
    @Query("status") status?: string,
  ) {
    return { data: await this.roles.listCandidates(user.orgId, status ?? "PENDING") };
  }

  @Delete("duplicates/:candidateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:merges:manage")
  async dismiss(
    @CurrentUser() user: CurrentUserContext,
    @Param("candidateId") candidateId: string,
  ) {
    await this.roles.dismissCandidate(user.orgId, candidateId, user.userId);
    return { dismissed: true };
  }

  @Post("merges")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:merges:manage")
  @Idempotent("party.merge")
  async merge(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: { leftPartyId: string; rightPartyId: string },
  ) {
    return this.merges.merge(user.orgId, {
      leftPartyId: body.leftPartyId,
      rightPartyId: body.rightPartyId,
      decidedBy: "USER",
      userId: user.userId,
    });
  }

  @Post("merges/:partyMergeId/revert")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:merges:manage")
  @Idempotent("party.merge.revert")
  async revert(
    @CurrentUser() user: CurrentUserContext,
    @Param("partyMergeId") partyMergeId: string,
  ) {
    return this.merges.revert(user.orgId, partyMergeId, user.userId);
  }
}
