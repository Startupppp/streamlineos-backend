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
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { KbPageTemplatesService } from "./kb-page-templates.service";
import {
  createPageTemplateSchema,
  type CreatePageTemplateInput,
} from "./dto/kb-page-templates.schemas";

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
  async create(
    @Body(new ZodValidationPipe(createPageTemplateSchema)) body: CreatePageTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.templates.create(u, body);
  }

  @Delete("page-templates/:templateId")
  @HttpCode(204)
  @RequirePermission("kb:templates:manage")
  async remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<void> {
    await this.templates.remove(u.orgId, templateId);
  }
}
