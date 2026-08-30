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
import { AssetsService } from "./assets.service";
import {
  createAssetSchema, listAssetsQuerySchema, updateAssetSchema, disposeAssetSchema,
  type CreateAssetInput, type ListAssetsQuery, type UpdateAssetInput, type DisposeAssetInput,
} from "./dto/assets.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const assetIdParams = z.object({ assetId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/assets")
@UseGuards(JwtAuthGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:read")
  @Validate({ query: listAssetsQuerySchema })
  list(
    @Query() query: ListAssetsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.list(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:create")
  @HttpCode(201)
  @Validate({ body: createAssetSchema })
  create(
    @Body() body: CreateAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.create(u, body);
  }

  @Get(":assetId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:read")
  @Validate({ params: assetIdParams })
  getOne(
    @Param("assetId", ParseIntPipe) assetId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.getOne(u.orgId, assetId);
  }

  @Patch(":assetId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:update")
  @Validate({ params: assetIdParams, body: updateAssetSchema })
  update(
    @Param("assetId", ParseIntPipe) assetId: number,
    @Body() body: UpdateAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.update(u.orgId, assetId, body);
  }

  @Post(":assetId/activate")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:assets:update")
  @HttpCode(200)
  @Validate({ params: assetIdParams })
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
  @Validate({ params: assetIdParams, body: disposeAssetSchema })
  dispose(
    @Param("assetId", ParseIntPipe) assetId: number,
    @Body() body: DisposeAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.dispose(u, assetId, body);
  }
}
