import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AssetInventoryService } from "./asset-inventory.service";
import {
  assignAssetSchema,
  createAssetSchema,
  patchAssetSchema,
  type AssignAssetInput,
  type CreateAssetInput,
  type PatchAssetInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AssetInventoryController {
  constructor(private readonly assets: AssetInventoryService) {}

  @Get("assets")
  @RequirePermission("hr:assets:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.assets.list(u.orgId);
  }

  @Post("assets")
  @HttpCode(201)
  @RequirePermission("hr:assets:manage")
  create(
    @Body(new ZodValidationPipe(createAssetSchema)) body: CreateAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.create(u.orgId, body);
  }

  @Patch("assets/:assetId")
  @RequirePermission("hr:assets:manage")
  update(
    @Param("assetId", ParseIntPipe) assetId: number,
    @Body(new ZodValidationPipe(patchAssetSchema)) body: PatchAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.update(u.orgId, assetId, body);
  }

  @Patch("assets")
  @RequirePermission("hr:assets:manage")
  assign(
    @Body(new ZodValidationPipe(assignAssetSchema)) body: AssignAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.assign(u.orgId, body);
  }
}
