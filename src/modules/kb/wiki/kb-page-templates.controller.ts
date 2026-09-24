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
import { KbPageTemplatesService } from "./kb-page-templates.service";
import {
  createPageTemplateSchema,
  listPageTemplatesQuerySchema,
  type CreatePageTemplateInput,
  type ListPageTemplatesQuery,
} from "./dto/kb-page-templates.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema, NoContentResponse } from "../../../common/openapi/zod-operation-contracts";
import {
  kbPageTemplateListPageSchema,
  kbPageTemplateSchema,
} from "./dto/kb-wiki-response.schemas";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPageTemplatesController {
  constructor(private readonly templates: KbPageTemplatesService) {}

  @Get("page-templates")
  @RequirePermission("kb:pages:view")
  @Validate({ query: listPageTemplatesQuerySchema })
  @ResponseSchema(kbPageTemplateListPageSchema)
  async list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: ListPageTemplatesQuery,
  ): Promise<unknown> {
    return this.templates.list(u.orgId, query);
  }

  @Post("page-templates")
  @RequirePermission("kb:templates:manage")
  @Validate({ body: createPageTemplateSchema })
  @ResponseSchema(kbPageTemplateSchema)
  async create(
    @Body() body: CreatePageTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.templates.create(u, body);
  }

  @Delete("page-templates/:templateId")
  @HttpCode(204)
  @NoContentResponse()
  @RequirePermission("kb:templates:manage")
  @Validate({ params: templateIdParams })
  async remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.templates.remove(u.orgId, templateId);
  }
}
