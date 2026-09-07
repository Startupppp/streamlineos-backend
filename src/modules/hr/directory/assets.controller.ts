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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { AccessService } from "../../access/access.service";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { NoContentResponse, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  assetReturnRowSchema,
  deviceRowSchema,
} from "./dto/directory-response.schemas";
import { successSchema } from "../../../common/openapi/response-envelopes";
import { z } from "zod";

const returnIdParams = z.object({ returnId: z.coerce.number().int().positive() }).strict();
const deviceIdParams = z.object({ deviceId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrAssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly access: AccessService,
  ) {}

  @Get("asset-returns")
  @ResponseSchema(z.array(assetReturnRowSchema))
  @RequirePermission("hr:assets:view")
  async listAssetReturns(@CurrentUser() u: CurrentUserContext) {
    const scope = await resolveAssetsScope(this.access, u);
    return this.assets.listAssetReturns(u.orgId, u.userId, scope);
  }

  @Post("asset-returns")
  @ResponseSchema(assetReturnRowSchema)
  @RequirePermission("hr:assets:manage")
  @HttpCode(201)
  @Validate({ body: createAssetReturnSchema })
  createAssetReturn(
    @Body() body: CreateAssetReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.createAssetReturn(u.orgId, body);
  }

  @Patch("asset-returns/:returnId")
  @ResponseSchema(assetReturnRowSchema)
  @RequirePermission("hr:assets:manage")
  @Validate({ params: returnIdParams, body: patchAssetReturnSchema })
  updateAssetReturn(
    @Param("returnId", ParseIntPipe) returnId: number,
    @Body() body: PatchAssetReturnInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.updateAssetReturn(u.orgId, returnId, body);
  }

  @Get("devices")
  @ResponseSchema(z.array(deviceRowSchema))
  @RequirePermission("hr:assets:view")
  listDevices(@CurrentUser() u: CurrentUserContext) {
    return this.assets.listDevices(u.orgId);
  }

  @Post("devices")
  @ResponseSchema(deviceRowSchema)
  @HttpCode(201)
  @RequirePermission("hr:assets:manage")
  @Validate({ body: createDeviceSchema })
  createDevice(
    @Body() body: CreateDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.createDevice(u.orgId, body);
  }

  @Patch("devices/:deviceId")
  @ResponseSchema(successSchema)
  @RequirePermission("hr:assets:manage")
  @Validate({ params: deviceIdParams, body: patchDeviceSchema })
  updateDevice(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body() body: PatchDeviceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assets.updateDevice(u.orgId, deviceId, body);
  }

  @Delete("devices/:deviceId")
  @NoContentResponse()
  @HttpCode(204)
  @RequirePermission("hr:assets:manage")
  @Validate({ params: deviceIdParams })
  deleteDevice(@Param("deviceId", ParseIntPipe) deviceId: number, @CurrentUser() u: CurrentUserContext) {
    return this.assets.deleteDevice(u.orgId, deviceId);
  }
}
