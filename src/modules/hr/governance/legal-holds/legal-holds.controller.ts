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
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { LegalHoldsService } from "./legal-holds.service";
import {
  createLegalHoldSchema,
  updateLegalHoldSchema,
  listLegalHoldsSchema,
  attachHoldItemSchema,
  type CreateLegalHoldInput,
  type UpdateLegalHoldInput,
  type ListLegalHoldsInput,
  type AttachHoldItemInput,
} from "./legal-holds.dto";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema, NoContentResponse } from "../../../../common/openapi/zod-operation-contracts";
import { listLegalHoldsResponseSchema, createLegalHoldResponseSchema, getLegalHoldResponseSchema, updateLegalHoldResponseSchema, releaseLegalHoldResponseSchema, listLegalHoldItemsResponseSchema, attachHoldItemResponseSchema } from "../dto/governance-response.schemas"

const holdIdParams = z.object({ holdId: z.coerce.number().int().positive() }).strict();
const holdIditemIdParams = z.object({ holdId: z.coerce.number().int().positive(), itemId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/governance/legal-holds")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LegalHoldsController {
  constructor(private readonly service: LegalHoldsService) {}

  @ResponseSchema(listLegalHoldsResponseSchema)
  @Get()
  @RequirePermission("hr:legalhold:view")
  @Validate({ query: listLegalHoldsSchema })
  async list(
    @CurrentUser() user: CurrentUserContext,
    @Query() query: ListLegalHoldsInput,
  ) {
    return this.service.list(user.orgId, query);
  }

  @ResponseSchema(createLegalHoldResponseSchema)
  @Post()
  @RequirePermission("hr:legalhold:manage")
  @Validate({ body: createLegalHoldSchema })
  async create(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: CreateLegalHoldInput,
    @Req() req: Request,
  ) {
    return this.service.create(user.orgId, user.userId, body, req.ip);
  }

  @ResponseSchema(getLegalHoldResponseSchema)
  @Get(":holdId")
  @RequirePermission("hr:legalhold:view")
  @Validate({ params: holdIdParams })
  async getById(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
  ) {
    return this.service.getById(user.orgId, holdId);
  }

  @ResponseSchema(updateLegalHoldResponseSchema)
  @Patch(":holdId")
  @RequirePermission("hr:legalhold:manage")
  @Validate({ params: holdIdParams, body: updateLegalHoldSchema })
  async update(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Body() body: UpdateLegalHoldInput,
    @Req() req: Request,
  ) {
    return this.service.update(user.orgId, holdId, user.userId, body, req.ip);
  }

  @ResponseSchema(releaseLegalHoldResponseSchema)
  @Post(":holdId/release")
  @BodylessAction()
  @RequirePermission("hr:legalhold:manage")
  @Validate({ params: holdIdParams })
  async release(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Req() req: Request,
  ) {
    return this.service.release(user.orgId, holdId, user.userId, req.ip);
  }

  @NoContentResponse()
  @Delete(":holdId")
  @RequirePermission("hr:legalhold:manage")
  @HttpCode(204)
  @Validate({ params: holdIdParams })
  async softDelete(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Req() req: Request,
  ) {
    await this.service.softDelete(user.orgId, holdId, user.userId, req.ip);
  }

  @ResponseSchema(listLegalHoldItemsResponseSchema)
  @Get(":holdId/items")
  @RequirePermission("hr:legalhold:view")
  @Validate({ params: holdIdParams })
  async listItems(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
  ) {
    return this.service.listItems(user.orgId, holdId);
  }

  @ResponseSchema(attachHoldItemResponseSchema)
  @Post(":holdId/items")
  @RequirePermission("hr:legalhold:manage")
  @Validate({ params: holdIdParams, body: attachHoldItemSchema })
  async attachItem(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Body() body: AttachHoldItemInput,
    @Req() req: Request,
  ) {
    return this.service.attachItem(user.orgId, holdId, user.userId, body, req.ip);
  }

  @NoContentResponse()
  @Delete(":holdId/items/:itemId")
  @RequirePermission("hr:legalhold:manage")
  @HttpCode(204)
  @Validate({ params: holdIditemIdParams })
  async detachItem(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Req() req: Request,
  ) {
    await this.service.detachItem(user.orgId, holdId, itemId, user.userId, req.ip);
  }
}
