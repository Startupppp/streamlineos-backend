import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequirePermission } from "./require-permission.decorator";
import { PermissionGuard } from "./permission.guard";
import { ResourceGrantsService, type GrantResourceInput } from "./resource-grants.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { ResourceGrant } from "../../db/schema";
import { z } from "zod";

const grantInputSchema = z.object({
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(36),
  principalType: z.enum(["user", "role"]),
  principalId: z.string().min(1).max(36),
  permissionKey: z.string().min(1).max(128),
});

@Controller("access/resource-grants")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ResourceGrantsController {
  constructor(private readonly resourceGrantsService: ResourceGrantsService) {}

  @Get()
  @RequirePermission("settings:rbac:manage")
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query("resourceType") resourceType: string,
    @Query("resourceId") resourceId: string,
  ): Promise<ResourceGrant[]> {
    return this.resourceGrantsService.listGrants(u.orgId, resourceType, resourceId);
  }

  @Post()
  @RequirePermission("settings:rbac:manage")
  grant(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(grantInputSchema)) body: GrantResourceInput,
  ): Promise<ResourceGrant | null> {
    return this.resourceGrantsService.grant(u.orgId, body, u.userId);
  }

  @Delete(":grantId")
  @RequirePermission("settings:rbac:manage")
  revoke(
    @CurrentUser() u: CurrentUserContext,
    @Param("grantId") grantId: string,
  ): Promise<{ success: boolean }> {
    return this.resourceGrantsService.revoke(u.orgId, grantId);
  }
}
