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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
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

@RequireModule("hr")
@Controller("hr/governance/legal-holds")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class LegalHoldsController {
  constructor(private readonly service: LegalHoldsService) {}

  @Get()
  @RequirePermission("hr:legalhold:view")
  async list(
    @CurrentUser() user: CurrentUserContext,
    @Query(new ZodValidationPipe(listLegalHoldsSchema)) query: ListLegalHoldsInput,
  ) {
    return this.service.list(user.orgId, query);
  }

  @Post()
  @RequirePermission("hr:legalhold:manage")
  async create(
    @CurrentUser() user: CurrentUserContext,
    @Body(new ZodValidationPipe(createLegalHoldSchema)) body: CreateLegalHoldInput,
    @Req() req: Request,
  ) {
    return this.service.create(user.orgId, user.userId, body, req.ip);
  }

  @Get(":holdId")
  @RequirePermission("hr:legalhold:view")
  async getById(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
  ) {
    return this.service.getById(user.orgId, holdId);
  }

  @Patch(":holdId")
  @RequirePermission("hr:legalhold:manage")
  async update(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Body(new ZodValidationPipe(updateLegalHoldSchema)) body: UpdateLegalHoldInput,
    @Req() req: Request,
  ) {
    return this.service.update(user.orgId, holdId, user.userId, body, req.ip);
  }

  @Post(":holdId/release")
  @RequirePermission("hr:legalhold:manage")
  async release(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Req() req: Request,
  ) {
    return this.service.release(user.orgId, holdId, user.userId, req.ip);
  }

  @Delete(":holdId")
  @RequirePermission("hr:legalhold:manage")
  @HttpCode(204)
  async softDelete(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Req() req: Request,
  ) {
    await this.service.softDelete(user.orgId, holdId, user.userId, req.ip);
  }

  @Get(":holdId/items")
  @RequirePermission("hr:legalhold:view")
  async listItems(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
  ) {
    return this.service.listItems(user.orgId, holdId);
  }

  @Post(":holdId/items")
  @RequirePermission("hr:legalhold:manage")
  async attachItem(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Body(new ZodValidationPipe(attachHoldItemSchema)) body: AttachHoldItemInput,
    @Req() req: Request,
  ) {
    return this.service.attachItem(user.orgId, holdId, user.userId, body, req.ip);
  }

  @Delete(":holdId/items/:itemId")
  @RequirePermission("hr:legalhold:manage")
  @HttpCode(204)
  async detachItem(
    @CurrentUser() user: CurrentUserContext,
    @Param("holdId", ParseIntPipe) holdId: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Req() req: Request,
  ) {
    await this.service.detachItem(user.orgId, holdId, itemId, user.userId, req.ip);
  }
}
