import { Body, Controller, Delete, Get, Param, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Universal } from "../../common/auth/universal.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  saveLayoutAdjustmentSchema,
  type SaveLayoutAdjustmentInput,
} from "./dto/record-layouts.schemas";
import { RecordLayoutsService } from "./record-layouts.service";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const layoutKeyParams = z.object({ layoutKey: z.string().min(1) }).strict();

@Controller("renderer/layouts")
export class RecordLayoutsController {
  constructor(private readonly layouts: RecordLayoutsService) {}

  @Get(":layoutKey")
  @Universal()
  @Validate({ params: layoutKeyParams })
  get(
    @Param("layoutKey") layoutKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.layouts.get(u.orgId, layoutKey);
  }

  @Put(":layoutKey")
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission("settings:record-layouts:manage")
  @Validate({ params: layoutKeyParams, body: saveLayoutAdjustmentSchema })
  save(
    @Param("layoutKey") layoutKey: string,
    @Body() body: SaveLayoutAdjustmentInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.layouts.save(u.orgId, u.userId, layoutKey, body);
  }

  @Delete(":layoutKey")
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission("settings:record-layouts:manage")
  @Validate({ params: layoutKeyParams })
  reset(
    @Param("layoutKey") layoutKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.layouts.remove(u.orgId, layoutKey);
  }

  @Get(":layoutKey/usage")
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission("settings:record-layouts:manage")
  @Validate({ params: layoutKeyParams })
  usage(
    @Param("layoutKey") layoutKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.layouts.usage(u.orgId, layoutKey);
  }
}
