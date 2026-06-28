import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequirePermission } from "./require-permission.decorator";
import { PermissionGuard } from "./permission.guard";
import { ResourceGrantsService, type PaginatedGrants } from "./resource-grants.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import type { ResourceGrant } from "../../db/schema";
import { z } from "zod";

const grantInputSchema = z.object({
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(36),
  principalType: z.enum(["user", "role"]),
  principalId: z.string().min(1).max(36),
  permissionKey: z.string().min(1).max(128),
  callerManagesResource: z.boolean(),
});

const listQuerySchema = z.object({
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(36),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const grantIdParamSchema = z.object({
  grantId: z.string().uuid(),
});

type ListQuery = z.infer<typeof listQuerySchema>;
type GrantIdParam = z.infer<typeof grantIdParamSchema>;
type GrantInput = z.infer<typeof grantInputSchema>;

@Controller("access/resource-grants")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ResourceGrantsController {
  constructor(private readonly resourceGrantsService: ResourceGrantsService) {}

  @Get()
  @RequirePermission("settings:rbac:manage")
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery,
  ): Promise<PaginatedGrants> {
    return this.resourceGrantsService.listGrants(u.orgId, query.resourceType, query.resourceId, {
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Post()
  @RequirePermission("settings:rbac:manage")
  grant(
    @CurrentUser() u: CurrentUserContext,
    @Body(new ZodValidationPipe(grantInputSchema)) body: GrantInput,
  ): Promise<ResourceGrant | null> {
    const { callerManagesResource, ...grantInput } = body;
    return this.resourceGrantsService.grant(u.orgId, grantInput, u.userId, callerManagesResource);
  }

  @Delete(":grantId")
  @RequirePermission("settings:rbac:manage")
  revoke(
    @CurrentUser() u: CurrentUserContext,
    @Param(new ZodValidationPipe(grantIdParamSchema)) params: GrantIdParam,
  ): Promise<{ success: boolean }> {
    return this.resourceGrantsService.revoke(u.orgId, params.grantId);
  }
}
