import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RecallsService } from "./quality-recalls.service";
import { listRecallsQuerySchema, createRecallSchema, updateRecallSchema } from "./dto/quality.schemas";
import type { ListRecallsQueryInput, CreateRecallInput, UpdateRecallInput } from "./dto/quality.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  listRecallsResponseSchema,
  getRecallResponseSchema,
  createRecallResponseSchema,
} from "./dto/quality-response.schemas";

const recallIdParams = z.object({ recallId: z.coerce.number().int().positive() }).strict();

@RequireModule("inventory")
@Controller("inventory/quality/recalls")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class RecallsController {
  constructor(private readonly svc: RecallsService) {}

  @Get()
  @ResponseSchema(listRecallsResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ query: listRecallsQuerySchema })
  list(
    @Query() q: ListRecallsQueryInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, q);
  }

  @Get(":recallId")
  @ResponseSchema(getRecallResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:read")
  @Validate({ params: recallIdParams })
  findOne(
    @Param("recallId", ParseIntPipe) id: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.findOne(u.orgId, id);
  }

  @Post()
  @ResponseSchema(createRecallResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:recall")
  @Validate({ body: createRecallSchema })
  create(
    @Body() body: CreateRecallInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Patch(":recallId")
  @ResponseSchema(createRecallResponseSchema)
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:quality:recall")
  @Validate({ params: recallIdParams, body: updateRecallSchema })
  update(
    @Param("recallId", ParseIntPipe) id: number,
    @Body() body: UpdateRecallInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, id, body);
  }
}
