import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { CrmWebFormsService } from "./crm-web-forms.service";
import {
  webFormCreateSchema,
  webFormUpdateSchema,
  type WebFormCreateInput,
  type WebFormUpdateInput,
} from "./dto/web-forms.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const formIdParams = z.object({ formId: z.coerce.number().int().positive() }).strict();

@RequireModule("crm")
@Controller("crm/web-forms")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CrmWebFormsController {
  constructor(private readonly forms: CrmWebFormsService) {}

  @Get()
  @RequirePermission("crm:web-forms:manage")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.forms.list(u.orgId);
  }

  @Post()
  @RequirePermission("crm:web-forms:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(webFormCreateSchema)) body: WebFormCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.forms.create(u.orgId, u.userId, body);
  }

  @Patch(":formId")
  @RequirePermission("crm:web-forms:manage")
  @Validate({ params: formIdParams })
  async update(
    @Param("formId", ParseIntPipe) formId: number,
    @Body(new ZodValidationPipe(webFormUpdateSchema)) body: WebFormUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.forms.exists(u.orgId, formId);
    if (!exists) throw new NotFoundException("Form not found");
    return this.forms.update(u.orgId, formId, body);
  }

  @Delete(":formId")
  @HttpCode(204)
  @RequirePermission("crm:web-forms:manage")
  @Validate({ params: formIdParams })
  async remove(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.forms.exists(u.orgId, formId);
    if (!exists) throw new NotFoundException("Form not found");
    await this.forms.remove(u.orgId, formId);
  }
}
