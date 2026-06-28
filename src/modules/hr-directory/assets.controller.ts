import {
  Body,
  Controller,
  Delete,
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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AssetsService } from "./assets.service";
import { userCan } from "./ability.helpers";
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

@Controller("hr")
@UseGuards(JwtAuthGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get("asset-returns")
  listAssetReturns(@CurrentUser() u: CurrentUserContext) {
    const isAdmin = userCan(u, "manage", "hr:assets");
    return this.assets.listAssetReturns(u.orgId, u.userId, isAdmin);
  }

  @Post("asset-returns")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:assets:manage")
  @HttpCode(201)
  createAssetReturn(
    @Body(new ZodValidationPipe(createAssetReturnSchema)) body: CreateAssetReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.createAssetReturn(u.orgId, body);
  }

  @Patch("asset-returns/:returnId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:assets:manage")
  updateAssetReturn(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body(new ZodValidationPipe(patchAssetReturnSchema)) body: PatchAssetReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.updateAssetReturn(u.orgId, returnId, body);
  }

  @Get("devices")
  listDevices(@CurrentUser() u: CurrentUserContext) {
    return this.assets.listDevices(u.orgId);
  }

  @Post("devices")
  @HttpCode(201)
  createDevice(
    @Body(new ZodValidationPipe(createDeviceSchema)) body: CreateDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!userCan(u, "manage", "hr:assets")) {
      throw new ForbiddenException("Only admins can add devices.");
    }
    return this.assets.createDevice(u.orgId, body);
  }

  @Patch("devices/:deviceId")
  updateDevice(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body(new ZodValidationPipe(patchDeviceSchema)) body: PatchDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!userCan(u, "manage", "hr:assets")) {
      throw new ForbiddenException("Only admins can update devices.");
    }
    return this.assets.updateDevice(u.orgId, deviceId, body);
  }

  @Delete("devices/:deviceId")
  deleteDevice(@Param("deviceId", ParseIntPipe) deviceId: number, @CurrentUser() u: CurrentUserContext) {
    if (!userCan(u, "manage", "hr:assets")) {
      throw new ForbiddenException("Only admins can delete devices.");
    }
    return this.assets.deleteDevice(u.orgId, deviceId);
  }
}
