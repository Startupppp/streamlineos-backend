import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { PartyMergeService } from "./party-merge.service";
import { PartyRevertService } from "./party-revert.service";
import { PartyRolesService } from "./party-roles.service";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  partyRolesSchema,
  detectResultSchema,
  duplicateCandidatesSchema,
  dismissedSchema,
  mergeOutcomeSchema,
  revertResultSchema,
} from "./dto/party-response.schemas";
import {
  partyDuplicateQuerySchema,
  partyMergeListQuerySchema,
  partyMergeSchema,
  partyRoleSchema,
  type PartyDuplicateQuery,
  type PartyMergeInput,
  type PartyMergeListQuery,
  type PartyRoleInput,
} from "./dto/party.schemas";
import { z } from "zod";

const partyIdParams = z.object({ partyId: z.string().min(1) }).strict();
const partyIdroleParams = z.object({ partyId: z.string().min(1), role: z.string().min(1) }).strict();
const candidateIdParams = z.object({ candidateId: z.string().min(1) }).strict();
const partyMergeIdParams = z.object({ partyMergeId: z.string().min(1) }).strict();

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
    private readonly reverts: PartyRevertService,
  ) {}

  @Get("parties/:partyId/roles")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:parties:view")
  @ResponseSchema(partyRolesSchema)
  @Validate({ params: partyIdParams })
  async listRoles(@CurrentUser() user: CurrentUserContext, @Param("partyId") partyId: string) {
    return { roles: await this.roles.listRoles(user.orgId, partyId) };
  }

  @Post("parties/:partyId/roles")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:roles:manage")
  @Idempotent("party.role.add")
  @ResponseSchema(partyRolesSchema)
  @Validate({ params: partyIdParams, body: partyRoleSchema })
  async addRole(
    @CurrentUser() user: CurrentUserContext,
    @Param("partyId") partyId: string,
    @Body() body: PartyRoleInput,
  ) {
    return { roles: await this.roles.addRole(user.orgId, partyId, body.role, user.userId) };
  }

  @Delete("parties/:partyId/roles/:role")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:roles:manage")
  @ResponseSchema(partyRolesSchema)
  @Validate({ params: partyIdroleParams })
  async removeRole(
    @CurrentUser() user: CurrentUserContext,
    @Param("partyId") partyId: string,
    @Param("role") role: string,
  ) {
    return { roles: await this.roles.removeRole(user.orgId, partyId, role, user.userId) };
  }

  @Post("parties/:partyId/detect-duplicates")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("party:merges:manage")
  @Idempotent("party.duplicates.detect")
  @ResponseSchema(detectResultSchema)
  @Validate({ params: partyIdParams })
  async detect(@CurrentUser() user: CurrentUserContext, @Param("partyId") partyId: string) {
    return this.roles.detectFor(user.orgId, partyId, user.userId);
  }

  @Get("duplicates")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:duplicates:view")
  @ResponseSchema(duplicateCandidatesSchema)
  @Validate({ query: partyDuplicateQuerySchema })
  async listCandidates(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: PartyDuplicateQuery,
  ) {
    return this.roles.listCandidates(user.orgId, query);
  }

  @Delete("duplicates/:candidateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:merges:manage")
  @ResponseSchema(dismissedSchema)
  @Validate({ params: candidateIdParams })
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
  @ResponseSchema(mergeOutcomeSchema)
  @Validate({ body: partyMergeSchema })
  async merge(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: PartyMergeInput,
  ) {
    return this.merges.merge(user.orgId, {
      leftPartyId: body.leftPartyId,
      rightPartyId: body.rightPartyId,
      decidedBy: "USER",
      userId: user.userId,
      // A merge reached through this route is one a person confirmed, so the
      // record they picked survives. Without this the service fell back to
      // `chooseSurvivor` and kept whichever was older, discarding the answer to
      // the only question the dialog asks.
      preferSurvivorPartyId: body.preferSurvivorPartyId,
    });
  }

  /**
   * What has been merged, so a merge can be undone after the fact.
   *
   * `party:merges:manage` rather than a view key: this list exists to be acted
   * on, every row is a revert control, and a second key naming the same set for
   * reading would only be a weaker way in.
   */
  @Get("merges")
  @UseGuards(PermissionGuard)
  @RequirePermission("party:merges:manage")
  @Validate({ query: partyMergeListQuerySchema })
  async listMerges(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: PartyMergeListQuery,
  ) {
    return this.merges.listMerges(user.orgId, query);
  }

  @Post("merges/:partyMergeId/revert")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("party:merges:manage")
  @Idempotent("party.merge.revert")
  @ResponseSchema(revertResultSchema)
  @Validate({ params: partyMergeIdParams })
  async revert(
    @CurrentUser() user: CurrentUserContext,
    @Param("partyMergeId") partyMergeId: string,
  ) {
    return this.reverts.revert(user.orgId, partyMergeId, user.userId);
  }
}
