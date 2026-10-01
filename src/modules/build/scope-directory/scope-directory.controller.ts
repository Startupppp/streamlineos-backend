import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { ScopeDirectoryService } from "./scope-directory.service";
import {
  resolveScopeDirectorySchema,
  scopeDirectoryResponseSchema,
  searchScopeDirectoryQuerySchema,
  searchScopeDirectoryResponseSchema,
  type ResolveScopeDirectoryInput,
  type SearchScopeDirectoryQuery,
} from "./dto/scope-directory.schemas";

@RequireModule("build")
@Controller("build/scope-directory")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ScopeDirectoryController {
  constructor(private readonly svc: ScopeDirectoryService) {}

  @Post("resolve")
  @HttpCode(200)
  @RequirePermission("build:view")
  @ResponseSchema(scopeDirectoryResponseSchema)
  @Validate({ body: resolveScopeDirectorySchema })
  async resolve(
    @Body() body: ResolveScopeDirectoryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const data = await this.svc.resolveScopeDirectory(u, body.keys);
    return { data };
  }

  @Get("search")
  @RequirePermission("build:view")
  @ResponseSchema(searchScopeDirectoryResponseSchema)
  @Validate({ query: searchScopeDirectoryQuerySchema })
  async search(
    @Query() query: SearchScopeDirectoryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.searchScopeDirectory(
      u,
      query.q,
      query.limit,
      query.cursor,
    );
  }
}
