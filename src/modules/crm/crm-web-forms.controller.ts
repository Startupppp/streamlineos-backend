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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CrmWebFormsService } from "./crm-web-forms.service";
import {
  webFormCreateSchema,
  webFormUpdateSchema,
  type WebFormCreateInput,
  type WebFormUpdateInput,
} from "./dto/web-forms.schemas";

@Controller("crm/web-forms")
@UseGuards(JwtAuthGuard)
export class CrmWebFormsController {
  constructor(private readonly forms: CrmWebFormsService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.forms.list(u.orgId);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(webFormCreateSchema)) body: WebFormCreateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.forms.create(u.orgId, u.userId, body);
  }

  @Get(":formId")
  async getOne(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const form = await this.forms.getOne(u.orgId, formId);
    if (!form) throw new NotFoundException("Form not found");
    return form;
  }

  @Patch(":formId")
  async update(
    @Param("formId", ParseIntPipe) formId: number,
    @Body(new ZodValidationPipe(webFormUpdateSchema)) body: WebFormUpdateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.forms.exists(u.orgId, formId);
    if (!exists) throw new NotFoundException("Form not found");
    return this.forms.update(formId, body);
  }

  @Delete(":formId")
  async remove(
    @Param("formId", ParseIntPipe) formId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const exists = await this.forms.exists(u.orgId, formId);
    if (!exists) throw new NotFoundException("Form not found");
    return this.forms.remove(formId);
  }
}
