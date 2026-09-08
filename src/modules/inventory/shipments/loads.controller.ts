import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { LoadsService } from "./loads.service";
import {
  listLoadsQuerySchema,
  createLoadSchema,
  dispatchLoadSchema,
  closeLoadSchema,
  type ListLoadsQueryInput,
  type CreateLoadInput,
  type DispatchLoadInput,
  type CloseLoadInput,
} from "./dto/shipments.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";

const loadIdParams = z.object({ loadId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/loads")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class LoadsController {
  constructor(private readonly svc: LoadsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  @Validate({ query: listLoadsQuerySchema })
  list(
    @Query() query: ListLoadsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, u.userId, query);
  }

  @Get(":loadId")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  @Validate({ params: loadIdParams })
  findOne(
    @Param("loadId", ParseIntPipe) loadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, loadId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  @Idempotent("inventory.load.create")
  @Validate({ body: createLoadSchema })
  create(
    @Body() body: CreateLoadInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Post(":loadId/dispatch")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: loadIdParams, body: dispatchLoadSchema })
  dispatch(
    @IdempotencyKey() idempotencyKey: string,
    @Param("loadId", ParseIntPipe) loadId: number,
    @Body() body: DispatchLoadInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.dispatch(u.orgId, u.userId, loadId, body, idempotencyKey);
  }

  @Post(":loadId/close")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: loadIdParams, body: closeLoadSchema })
  close(
    @Param("loadId", ParseIntPipe) loadId: number,
    @Body() body: CloseLoadInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.close(u.orgId, u.userId, loadId, body);
  }

  @Post(":loadId/cancel")
  @BodylessAction()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:loads:manage")
  @HttpCode(HttpStatus.OK)
  @Validate({ params: loadIdParams })
  cancel(
    @Param("loadId", ParseIntPipe) loadId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.cancel(u.orgId, u.userId, loadId);
  }
}
