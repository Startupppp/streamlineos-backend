import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { TplService } from "./tpl.service";
import {
  create3plConnectionSchema,
  update3plConnectionSchema,
} from "./dto/channels.schemas";
import type {
  Create3plConnectionInput,
  Update3plConnectionInput,
} from "./dto/channels.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const connectionIdParams = z.object({ connectionId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/3pl")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class TplController {
  constructor(private readonly svc: TplService) {}

  @Get("connections")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:3pl:manage")
  listConnections(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listConnections(u.orgId);
  }

  @Post("connections")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:3pl:manage")
  @Validate({ body: create3plConnectionSchema })
  createConnection(
    @Body() body: Create3plConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createConnection(u.orgId, u.userId, body);
  }

  @Patch("connections/:connectionId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:3pl:manage")
  @Validate({ params: connectionIdParams, body: update3plConnectionSchema })
  updateConnection(
    @Param("connectionId", ParseIntPipe) id: number,
    @Body() body: Update3plConnectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateConnection(u.orgId, u.userId, id, body);
  }

  @Post("connections/:connectionId/sync")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:3pl:manage")
  @Validate({ params: connectionIdParams })
  syncConnection(
    @Param("connectionId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.syncConnection(u.orgId, u.userId, id);
  }
}
