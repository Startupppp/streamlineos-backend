import {
  Body, Controller, Get, HttpCode, Param, ParseIntPipe,
  Patch, Post, Query, UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AssetsService } from "./assets.service";
import {
  createAssetSchema, listAssetsQuerySchema, updateAssetSchema, disposeAssetSchema,
  type CreateAssetInput, type ListAssetsQuery, type UpdateAssetInput, type DisposeAssetInput,
} from "./dto/assets.schemas";

@RequireModule("accounting")
@Controller("accounting/assets")
@UseGuards(JwtAuthGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:read")
  list(
    @Query(new ZodValidationPipe(listAssetsQuerySchema)) query: ListAssetsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.list(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:create")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createAssetSchema)) body: CreateAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.create(u, body);
  }

  @Get(":assetId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:read")
  getOne(
    @Param("assetId", ParseIntPipe) assetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.getOne(u.orgId, assetId);
  }

  @Patch(":assetId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:update")
  update(
    @Param("assetId", ParseIntPipe) assetId: number,
    @Body(new ZodValidationPipe(updateAssetSchema)) body: UpdateAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.update(u.orgId, assetId, body);
  }

  @Post(":assetId/activate")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:update")
  @HttpCode(200)
  activate(
    @Param("assetId", ParseIntPipe) assetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.activate(u, assetId);
  }

  @Post(":assetId/dispose")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:manage")
  @HttpCode(200)
  dispose(
    @Param("assetId", ParseIntPipe) assetId: number,
    @Body(new ZodValidationPipe(disposeAssetSchema)) body: DisposeAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.dispose(u, assetId, body);
  }
}
