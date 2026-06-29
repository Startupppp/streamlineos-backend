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
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { HrHandbookService } from "./hr-handbook.service";
import {
  createHandbookSchema,
  updateHandbookSchema,
  type CreateHandbookInput,
  type UpdateHandbookInput,
} from "./dto/handbook.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr/handbook")
@UseGuards(JwtAuthGuard)
export class HrHandbookController {
  constructor(private readonly handbook: HrHandbookService) {}

  @Get()
  list(@CurrentUser() u: CurrentUserContext) {
    return this.handbook.list(u.orgId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:handbook:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createHandbookSchema)) body: CreateHandbookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.handbook.create(u.orgId, body);
  }

  @Patch(":handbookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:handbook:manage")
  async update(
    @Param("handbookId", ParseIntPipe) handbookId: number,
    @Body(new ZodValidationPipe(updateHandbookSchema)) body: UpdateHandbookInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.handbook.getById(u.orgId, handbookId);
    if (!existing) throw new NotFoundException("Handbook version not found");
    return this.handbook.update(u.orgId, u.userId, existing, body);
  }

  @Delete(":handbookId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:handbook:manage")
  async remove(
    @Param("handbookId", ParseIntPipe) handbookId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const existing = await this.handbook.getById(u.orgId, handbookId);
    if (!existing) throw new NotFoundException("Handbook version not found");
    return this.handbook.remove(u.orgId, existing);
  }
}
