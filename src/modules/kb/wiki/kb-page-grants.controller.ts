import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import { KbPageGrantsService } from "./kb-page-grants.service";
import {
  kbPageGrantParamsSchema,
  kbPageGrantItemParamsSchema,
  kbPageGrantsListQuerySchema,
  createKbPageGrantSchema,
  type KbPageGrantsListQuery,
  type CreateKbPageGrantInput,
} from "./dto/kb-page-grants.schemas";
import {
  kbPageGrantItemSchema,
  kbPageGrantsPageSchema,
} from "./dto/kb-page-grants-response.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPageGrantsController {
  constructor(private readonly grants: KbPageGrantsService) {}

  @Get("pages/:pageId/grants")
  @RequirePermission("kb:pages:view")
  @Validate({ params: kbPageGrantParamsSchema, query: kbPageGrantsListQuerySchema })
  @ResponseSchema(kbPageGrantsPageSchema)
  async list(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Query() query: KbPageGrantsListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grants.list(u, pageId, query);
  }

  @Post("pages/:pageId/grants")
  @HttpCode(201)
  @RequirePermission("kb:pages:update")
  @Validate({ params: kbPageGrantParamsSchema, body: createKbPageGrantSchema })
  @ResponseSchema(kbPageGrantItemSchema)
  async create(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Body() body: CreateKbPageGrantInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.grants.create(u, pageId, body);
  }

  @Delete("pages/:pageId/grants/:grantId")
  @HttpCode(204)
  @RequirePermission("kb:pages:update")
  @Validate({ params: kbPageGrantItemParamsSchema })
  @NoContentResponse()
  async revoke(
    @Param("pageId", ParseIntPipe) pageId: number,
    @Param("grantId", ParseIntPipe) grantId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.grants.revoke(u, pageId, grantId);
  }
}
