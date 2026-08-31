import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { HrTemplatesService } from "./hr-templates.service";
import {
  createTemplateSchema,
  renderTemplateSchema,
  templateListQuerySchema,
  transitionTemplateSchema,
  updateTemplateSchema,
  type CreateTemplateInput,
  type RenderTemplateInput,
  type TemplateListQuery,
  type TransitionTemplateInput,
  type UpdateTemplateInput,
} from "./dto/hr-templates.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../../common/openapi/zod-operation-contracts";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/templates")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrTemplatesController {
  constructor(
    private readonly service: HrTemplatesService,
    private readonly access: AccessService,
  ) {}

  @Get("variables")
  @RequirePermission("hr:templates:view")
  listVariables() {
    return this.service.listVariables();
  }

  @Get()
  @RequirePermission("hr:templates:view")
  @Validate({ query: templateListQuerySchema })
  list(
    @Query() query: TemplateListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.list(u.orgId, query);
  }

  @Post()
  @RequirePermission("hr:templates:manage")
  @HttpCode(201)
  @Validate({ body: createTemplateSchema })
  create(
    @Body() body: CreateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.create(u.orgId, u.userId, body);
  }

  @Post("seed-defaults")
  @BodylessAction()
  @RequirePermission("hr:templates:manage")
  @HttpCode(200)
  seedDefaults(@CurrentUser() u: CurrentUserContext) {
    return this.service.seedDefaults(u.orgId, u.userId);
  }

  @Get(":templateId")
  @RequirePermission("hr:templates:view")
  @Validate({ params: templateIdParams })
  getOne(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getById(u.orgId, templateId);
  }

  @Patch(":templateId")
  @RequirePermission("hr:templates:manage")
  @Validate({ params: templateIdParams, body: updateTemplateSchema })
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: UpdateTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.update(u.orgId, u.userId, templateId, body);
  }

  @Post(":templateId/transition")
  @RequirePermission("hr:templates:manage")
  @HttpCode(200)
  @Validate({ params: templateIdParams, body: transitionTemplateSchema })
  transition(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: TransitionTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.transition(u.orgId, u.userId, templateId, body.to);
  }

  @Post(":templateId/versions")
  @BodylessAction()
  @RequirePermission("hr:templates:manage")
  @HttpCode(201)
  @Validate({ params: templateIdParams })
  newVersion(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createNewVersion(u.orgId, u.userId, templateId);
  }

  @Post(":templateId/render")
  @RequirePermission("hr:templates:view")
  @HttpCode(200)
  @Validate({ params: templateIdParams, body: renderTemplateSchema })
  async render(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: RenderTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (body.includeSensitive) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!u.isOrgOwner && !perms.has("hr:sensitive:view")) {
        throw new ForbiddenException("hr:sensitive:view permission required to include sensitive fields");
      }
    }
    return this.service.render(u.orgId, u.userId, templateId, body);
  }

  @Get(":templateId/renders")
  @RequirePermission("hr:templates:view")
  @Validate({ params: templateIdParams })
  listRenders(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listRenders(u.orgId, templateId);
  }
}
