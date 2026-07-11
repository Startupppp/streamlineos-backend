import {
  Body,
  Controller,
  Delete,
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
import { AccessService } from "../access/access.service";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AssetsService } from "./assets.service";
import { resolveAssetsScope } from "./assets-scope";
import {
  createAssetReturnSchema,
  createDeviceSchema,
  patchAssetReturnSchema,
  patchDeviceSchema,
  type CreateAssetReturnInput,
  type CreateDeviceInput,
  type PatchAssetReturnInput,
  type PatchDeviceInput,
} from "./dto/hr-directory.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly access: AccessService,
  ) {}

  @Get("asset-returns")
  @RequirePermission("hr:assets:view")
  async listAssetReturns(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolveAssetsScope(this.access, u);
    return this.assets.listAssetReturns(u.orgId, u.userId, scope);
  }

  @Post("asset-returns")
  @RequirePermission("hr:assets:manage")
  @HttpCode(201)
  createAssetReturn(
    @Body(new ZodValidationPipe(createAssetReturnSchema)) body: CreateAssetReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.createAssetReturn(u.orgId, body);
  }

  @Patch("asset-returns/:returnId")
  @RequirePermission("hr:assets:manage")
  updateAssetReturn(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body(new ZodValidationPipe(patchAssetReturnSchema)) body: PatchAssetReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.updateAssetReturn(u.orgId, returnId, body);
  }

  @Get("devices")
  @RequirePermission("hr:assets:view")
  listDevices(@CurrentUser() u: CurrentUserContext) {
    return this.assets.listDevices(u.orgId);
  }

  @Post("devices")
  @HttpCode(201)
  @RequirePermission("hr:assets:manage")
  createDevice(
    @Body(new ZodValidationPipe(createDeviceSchema)) body: CreateDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.createDevice(u.orgId, body);
  }

  @Patch("devices/:deviceId")
  @RequirePermission("hr:assets:manage")
  updateDevice(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body(new ZodValidationPipe(patchDeviceSchema)) body: PatchDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.updateDevice(u.orgId, deviceId, body);
  }

  @Delete("devices/:deviceId")
  @RequirePermission("hr:assets:manage")
  deleteDevice(@Param("deviceId", ParseIntPipe) deviceId: number, @CurrentUser() u: CurrentUserContext) {
    return this.assets.deleteDevice(u.orgId, deviceId);
  }
}
