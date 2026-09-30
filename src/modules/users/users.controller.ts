import {
  Controller, Get, HttpCode, Patch, Delete, Post, Param, Query, Body, UseGuards, Res, Version
} from "@nestjs/common";
import { API_VERSION_NEXT } from "../../common/http/api-version";
import { toUserIdentity, toUserIdentityPage } from "./user-identity.view";
import type { Response } from "express";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { UsersService } from "./users.service";
import { UserProfileService } from "./user-profile.service";
import { UserActivityService } from "./user-activity.service";
import { UserOpsService } from "./user-ops.service";
import { InvitationCreateService } from "../organization/core/invitation-create.service";
import { InvitationLifecycleService } from "../organization/core/invitation-lifecycle.service";
import { InvitationsReadService } from "../organization/core/invitations-read.service";
import {
  listUsersSchema, updateUserSchema, updateUserStatusSchema,
  inviteUserSchema, bulkInviteSchema, updatePreferencesSchema,
  updateMembershipSchema, bulkActionSchema, listLoginHistorySchema,
  bulkUpdateUsersSchema, listAuditSchema, importUsersBodySchema, createUserSchema,
  type ListUsersInput, type UpdateUserInput, type UpdateUserStatusInput,
  type InviteUserInput, type BulkInviteInput, type UpdatePreferencesInput,
  type UpdateMembershipInput, type BulkActionInput, type ListLoginHistoryInput,
  type BulkUpdateUsersInput, type ListAuditInput, type ImportUsersBody, type CreateUserInput,
  changeInviteRoleSchema,
  type ChangeInviteRoleInput,
  listInvitationsSchema,
  type ListInvitationsInput,
} from "./dto/users.schemas";
import { z } from "zod";
import { Validate } from "../../common/validation/validate.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { appUrl } from "../email/app-url";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  userListResponseSchema,
  userIdentityListResponseSchema,
  userStatsResponseSchema,
  invitationListResponseSchema,
  createUserResponseSchema,
  inviteUserResponseSchema,
  bulkInviteResponseSchema,
  bulkStatusResponseSchema,
  bulkUpdateResponseSchema,
  importUsersResponseSchema,
  invitationMutationResponseSchema,
  invitationJoinLinkResponseSchema,
  userIdentityResponseSchema,
  userDetailResponseSchema,
  userMutationResponseSchema,
  sendSigninLinkResponseSchema,
} from "./dto/users-response.schemas";
import {
  userSessionsResponseSchema,
  revokeSessionResponseSchema,
  exportUserDataResponseSchema,
  userAuditLogResponseSchema,
  orgAuditLogResponseSchema,
  userPreferencesResponseSchema,
  updatePreferencesResponseSchema,
  loginHistoryResponseSchema,
  userMembershipResponseSchema,
  updateMembershipResponseSchema,
} from "./dto/user-profile-response.schemas";

const invitationIdParams = z.object({ invitationId: z.string().min(1) }).strict();
const userIdParams = z.object({ userId: z.string().min(1) }).strict();
const userIdsessionIdParams = z.object({ userId: z.string().min(1), sessionId: z.string().min(1) }).strict();

@Controller("users")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly userProfile: UserProfileService,
    private readonly userActivity: UserActivityService,
    private readonly userOps: UserOpsService,
    private readonly invitationsCreate: InvitationCreateService,
    private readonly invitationsLifecycle: InvitationLifecycleService,
    private readonly invitationsRead: InvitationsReadService,
  ) {}

  // ── Static GET routes (must be before any :userId parameterized routes) ──

  @RequirePermission("settings:view")
  @ResponseSchema(userListResponseSchema)
  @Get()
  @Validate({ query: listUsersSchema })
  listUsers(
    @Query() query: ListUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.listUsers(u.orgId, query);
  }

  @RequirePermission("settings:view")
  @ResponseSchema(userIdentityListResponseSchema)
  @Version(API_VERSION_NEXT)
  @Get()
  @Validate({ query: listUsersSchema })
  async listUsersV2(
    @Query() query: ListUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return toUserIdentityPage(await this.users.listUsers(u.orgId, query));
  }

  @RequirePermission("settings:view")
  @ResponseSchema(userStatsResponseSchema)
  @Get("stats")
  getStats(@CurrentUser() u: CurrentUserContext) {
    return this.userOps.getStats(u.orgId);
  }

  @RequirePermission("settings:organization:manage")
  @ApiOkResponse({ schema: { type: "string" }, description: "CSV file" })
  @Get("export")
  async exportUsers(@CurrentUser() u: CurrentUserContext, @Res() res: Response) {
    const result = await this.userOps.exportUsers(u.orgId);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=users.csv");
    if (result.truncated) res.setHeader("X-Export-Truncated", "true");
    res.setHeader("X-Export-Row-Count", String(result.rowCount));
    res.send(result.csv);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(invitationListResponseSchema)
  @Get("invitations")
  @Validate({ query: listInvitationsSchema })
  listInvitations(
    @Query() query: ListInvitationsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitationsRead.listPaginated(u.orgId, {
      cursor: query.cursor,
      limit: query.limit,
      includeAccepted: query.includeAccepted,
      status: query.status,
      q: query.q,
    });
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(orgAuditLogResponseSchema)
  @Get("audit")
  @Validate({ query: listAuditSchema })
  getOrgAuditLog(
    @Query() query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userActivity.getAuditLog(u.orgId, query);
  }

  // ── Static POST routes ──

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(createUserResponseSchema)
  @Post()
  @Validate({ body: createUserSchema })
  createUser(
    @Body() body: CreateUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.createUser(u.orgId, body, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(inviteUserResponseSchema)
  @Post("invite")
  @Idempotent("users.invitation.create")
  @Validate({ body: inviteUserSchema })
  inviteUser(
    @Body() body: InviteUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitationsCreate.invite(
      u.orgId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner },
      body.email,
      body.role,
      body.moduleAccess,
    );
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(bulkInviteResponseSchema)
  @Post("bulk-invite")
  @Idempotent("users.invitation.bulk-create")
  @Validate({ body: bulkInviteSchema })
  bulkInvite(
    @Body() body: BulkInviteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitationsCreate.bulkInvite(
      u.orgId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner },
      body.emails,
      body.role,
      undefined,
      body.moduleAccess,
    );
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(bulkStatusResponseSchema)
  @Post("bulk-suspend")
  @HttpCode(200)
  @Validate({ body: bulkActionSchema })
  bulkSuspend(
    @Body() body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkSuspend(u.orgId, body.userIds, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(bulkStatusResponseSchema)
  @Post("bulk-archive")
  @HttpCode(200)
  @Validate({ body: bulkActionSchema })
  bulkArchive(
    @Body() body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkArchive(u.orgId, body.userIds, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(bulkStatusResponseSchema)
  @Post("bulk-restore")
  @HttpCode(200)
  @Validate({ body: bulkActionSchema })
  bulkRestore(
    @Body() body: BulkActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkRestore(u.orgId, body.userIds, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(bulkUpdateResponseSchema)
  @Post("bulk-update")
  @HttpCode(200)
  @Validate({ body: bulkUpdateUsersSchema })
  bulkUpdate(
    @Body() body: BulkUpdateUsersInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.bulkUpdateUsers(u.orgId, body, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(importUsersResponseSchema)
  @Post("import")
  @Validate({ body: importUsersBodySchema })
  importUsers(
    @Body() body: ImportUsersBody,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userOps.importUsers(u.orgId, body.rows, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  // ── Invitation sub-routes (static prefix "invitations/") ──

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(invitationMutationResponseSchema)
  @Post("invitations/:invitationId/resend")
  @Idempotent("users.invitation.resend")
  @HttpCode(200)
  @Validate({ params: invitationIdParams })
  @BodylessAction()
  async resendInvite(
    @Param("invitationId") invitationId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.invitationsLifecycle.resend(u.orgId, invitationId, {
      userId: u.userId,
      isOrgOwner: u.isOrgOwner,
    });
    return { success: true as const };
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(invitationJoinLinkResponseSchema)
  @Post("invitations/:invitationId/join-link")
  @HttpCode(200)
  @Validate({ params: invitationIdParams })
  @BodylessAction()
  @UseGuards(RateLimitGuard)
  @UseRateLimit("invite:reissue-link")
  async reissueInvitationJoinLink(
    @Param("invitationId") invitationId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const reissued = await this.invitationsLifecycle.resend(
      u.orgId,
      invitationId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner },
      { deliverEmail: false },
    );
    return {
      joinUrl: `${appUrl()}/invitation/${reissued.rawToken}`,
      email: reissued.email,
      expiresAt: reissued.expiresAt,
    };
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(invitationMutationResponseSchema)
  @Patch("invitations/:invitationId/role")
  @HttpCode(200)
  @Validate({ params: invitationIdParams, body: changeInviteRoleSchema })
  changeInviteRole(
    @Param("invitationId") invitationId: string,
    @Body() body: ChangeInviteRoleInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.invitationsLifecycle.changeRole(
      u.orgId,
      invitationId,
      { userId: u.userId, isOrgOwner: u.isOrgOwner },
      body.role,
    );
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(invitationMutationResponseSchema)
  @Delete("invitations/:invitationId")
  @Validate({ params: invitationIdParams })
  cancelInvite(@Param("invitationId") invitationId: string, @CurrentUser() u: CurrentUserContext) {
    return this.invitationsLifecycle.cancel(u.orgId, invitationId, {
      userId: u.userId,
      isOrgOwner: u.isOrgOwner,
    });
  }

  // ── Parameterized :userId routes (must come after all static routes) ──

  @RequirePermission("settings:view")
  @ResponseSchema(userIdentityResponseSchema)
  @Version(API_VERSION_NEXT)
  @Get(":userId")
  @Validate({ params: userIdParams })
  async getUserV2(
    @Param("userId") userId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return toUserIdentity(await this.users.getUser(u.orgId, userId));
  }

  @RequirePermission("settings:view")
  @ResponseSchema(userDetailResponseSchema)
  @Get(":userId")
  @Validate({ params: userIdParams })
  getUser(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.getUser(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(userMutationResponseSchema)
  @Patch(":userId")
  @Validate({ params: userIdParams, body: updateUserSchema })
  updateUser(
    @Param("userId") userId: string,
    @Body() body: UpdateUserInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updateUser(u.orgId, userId, body, { userId: u.userId, isOrgOwner: u.isOrgOwner });
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(userMutationResponseSchema)
  @Patch(":userId/status")
  @Validate({ params: userIdParams, body: updateUserStatusSchema })
  updateStatus(
    @Param("userId") userId: string,
    @Body() body: UpdateUserStatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.users.updateUserStatus(u.orgId, userId, body.status, u.userId, body.reason);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(userMutationResponseSchema)
  @Delete(":userId")
  @Validate({ params: userIdParams })
  deleteUser(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.users.deleteUser(u.orgId, userId, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(userSessionsResponseSchema)
  @Get(":userId/sessions")
  @Validate({ params: userIdParams })
  getSessions(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getUserSessions(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(revokeSessionResponseSchema)
  @Delete(":userId/sessions/:sessionId")
  @Validate({ params: userIdsessionIdParams })
  revokeSession(
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.revokeSession(u.orgId, userId, sessionId, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(revokeSessionResponseSchema)
  @Delete(":userId/sessions")
  @Validate({ params: userIdParams })
  revokeAllSessions(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.revokeAllSessions(u.orgId, userId, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(exportUserDataResponseSchema)
  @Get(":userId/data-export")
  @Validate({ params: userIdParams })
  exportUserData(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.exportUserData(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(userAuditLogResponseSchema)
  @Get(":userId/activity")
  @Validate({ params: userIdParams })
  getActivity(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userActivity.getUserActivity(u.orgId, userId);
  }

  @RequirePermission("settings:view")
  @ResponseSchema(userPreferencesResponseSchema)
  @Get(":userId/preferences")
  @Validate({ params: userIdParams })
  getPreferences(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getPreferences(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(updatePreferencesResponseSchema)
  @Patch(":userId/preferences")
  @Validate({ params: userIdParams, body: updatePreferencesSchema })
  updatePreferences(
    @Param("userId") userId: string,
    @Body() body: UpdatePreferencesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.updatePreferences(u.orgId, userId, body);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(loginHistoryResponseSchema)
  @Get(":userId/login-history")
  @Validate({ params: userIdParams, query: listLoginHistorySchema })
  getLoginHistory(
    @Param("userId") userId: string,
    @Query() query: ListLoginHistoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.getLoginHistory(u.orgId, userId, query);
  }

  @RequirePermission("settings:view")
  @ResponseSchema(userMembershipResponseSchema)
  @Get(":userId/membership")
  @Validate({ params: userIdParams })
  getMembership(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userProfile.getMembership(u.orgId, userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(updateMembershipResponseSchema)
  @Patch(":userId/membership")
  @Validate({ params: userIdParams, body: updateMembershipSchema })
  updateMembership(
    @Param("userId") userId: string,
    @Body() body: UpdateMembershipInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userProfile.updateMembership(u.orgId, userId, body, u.userId);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(sendSigninLinkResponseSchema)
  @Post(":userId/send-signin-link")
  @Idempotent("users.signin-link.send")
  @HttpCode(200)
  @Validate({ params: userIdParams })
  @BodylessAction()
  sendSigninLink(@Param("userId") userId: string, @CurrentUser() u: CurrentUserContext) {
    return this.userOps.sendSigninLink(u.orgId, userId, u);
  }

  @RequirePermission("settings:organization:manage")
  @ResponseSchema(userAuditLogResponseSchema)
  @Get(":userId/audit")
  @Validate({ params: userIdParams, query: listAuditSchema })
  getUserAuditLog(
    @Param("userId") userId: string,
    @Query() query: ListAuditInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.userActivity.getUserAuditLog(u.orgId, userId, query);
  }
}
