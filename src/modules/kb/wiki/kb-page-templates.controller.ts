import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbPageTemplatesService } from "./kb-page-templates.service";
import {
  createPageTemplateSchema,
  type CreatePageTemplateInput,
} from "./dto/kb-page-templates.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@Controller("kb")
@RequireModule("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbPageTemplatesController {
  constructor(private readonly templates: KbPageTemplatesService) {}

  @Get("page-templates")
  @RequirePermission("kb:pages:view")
  async list(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.templates.list(u.orgId);
  }

  @Post("page-templates")
  @RequirePermission("kb:templates:manage")
  @Validate({ body: createPageTemplateSchema })
  async create(
    @Body() body: CreatePageTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.templates.create(u, body);
  }

  @Delete("page-templates/:templateId")
  @HttpCode(204)
  @RequirePermission("kb:templates:manage")
  @Validate({ params: templateIdParams })
  async remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.templates.remove(u.orgId, templateId);
  }
}
