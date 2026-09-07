import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { AssetInventoryService } from "./asset-inventory.service";
import {
  assignAssetSchema,
  createAssetSchema,
  listAssetsQuerySchema,
  patchAssetSchema,
  type AssignAssetInput,
  type CreateAssetInput,
  type ListAssetsQueryInput,
  type PatchAssetInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../../common/openapi/response-envelopes";
import {
  assetListPageSchema,
  assetRowSchema,
} from "./dto/directory-response.schemas";
import { z } from "zod";

const assetIdParams = z.object({ assetId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AssetInventoryController {
  constructor(private readonly assets: AssetInventoryService) {}

  @Get("assets")
  @ResponseSchema(assetListPageSchema)
  @RequirePermission("hr:assets:view")
  @Validate({ query: listAssetsQuerySchema })
  list(
    @Query() query: ListAssetsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.list(u.orgId, query);
  }

  @Post("assets")
  @ResponseSchema(assetRowSchema)
  @HttpCode(201)
  @RequirePermission("hr:assets:manage")
  @Validate({ body: createAssetSchema })
  create(
    @Body() body: CreateAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.create(u.orgId, body);
  }

  @Patch("assets/:assetId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:assets:manage")
  @Validate({ params: assetIdParams, body: patchAssetSchema })
  update(
    @Param("assetId", ParseIntPipe) assetId: number,
    @Body() body: PatchAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.update(u.orgId, assetId, body);
  }

  @Patch("assets")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:assets:manage")
  @Validate({ body: assignAssetSchema })
  assign(
    @Body() body: AssignAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.assign(u.orgId, body);
  }
}
