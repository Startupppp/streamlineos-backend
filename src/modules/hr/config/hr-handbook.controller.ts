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

import { HrHandbookService } from "./hr-handbook.service";
import {
  createHandbookSchema,
  updateHandbookSchema,
  type CreateHandbookInput,
  type UpdateHandbookInput,
} from "./dto/handbook.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const handbookIdParams = z.object({ handbookId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr/handbook")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class HrHandbookController {
  constructor(private readonly handbook: HrHandbookService) {}

  @Get()
  @RequirePermission("hr:employees:view")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.handbook.list(u.orgId);
  }

  @Post()
  @RequirePermission("hr:handbook:manage")
  @HttpCode(201)
  @Validate({ body: createHandbookSchema })
  create(
    @Body() body: CreateHandbookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.handbook.create(u.orgId, body);
  }

  @Patch(":handbookId")
  @RequirePermission("hr:handbook:manage")
  @Validate({ params: handbookIdParams, body: updateHandbookSchema })
  async update(
    @Param("handbookId", ParseIntPipe) handbookId: number,
    @Body() body: UpdateHandbookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.handbook.getById(u.orgId, handbookId);
    if (!existing) throw new NotFoundException("Handbook version not found");
    return this.handbook.update(u.orgId, u.userId, existing, body);
  }

  @Delete(":handbookId")
  @HttpCode(204)
  @RequirePermission("hr:handbook:manage")
  @Validate({ params: handbookIdParams })
  async remove(
    @Param("handbookId", ParseIntPipe) handbookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.handbook.getById(u.orgId, handbookId);
    if (!existing) throw new NotFoundException("Handbook version not found");
    return this.handbook.remove(u.orgId, existing);
  }
}
