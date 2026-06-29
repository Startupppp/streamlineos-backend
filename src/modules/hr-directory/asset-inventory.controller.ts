import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AssetInventoryService } from "./asset-inventory.service";
import { userCan } from "./ability.helpers";
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
@UseGuards(JwtAuthGuard)
export class AssetInventoryController {
  constructor(private readonly assets: AssetInventoryService) {}

  private assertManageAccess(u: CurrentUserContext): void {
    if (!userCan(u, "manage", "hr:assets")) {
      throw new ForbiddenException("Only admins can manage assets.");
    }
  }

  @Get("assets")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.assets.list(u.orgId);
  }

  @Post("assets")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createAssetSchema)) body: CreateAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.assertManageAccess(u);
    return this.assets.create(u.orgId, body);
  }

  @Patch("assets/:assetId")
  update(
    @Param("assetId", ParseIntPipe) assetId: number,
    @Body(new ZodValidationPipe(patchAssetSchema)) body: PatchAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.assertManageAccess(u);
    return this.assets.update(u.orgId, assetId, body);
  }

  @Patch("assets")
  assign(
    @Body(new ZodValidationPipe(assignAssetSchema)) body: AssignAssetInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.assertManageAccess(u);
    return this.assets.assign(u.orgId, body);
  }
}
