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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RecurringBillsService } from "./recurring-bills.service";
import {
  createRecurringBillSchema,
  updateRecurringBillSchema,
  listRecurringBillsQuerySchema,
  type CreateRecurringBillInput,
  type UpdateRecurringBillInput,
  type ListRecurringBillsQuery,
} from "./dto/finance-ap.schemas";

@RequireModule("accounting")
@Controller("accounting/recurring-bills")
@UseGuards(JwtAuthGuard)
export class RecurringBillsController {
  constructor(private readonly service: RecurringBillsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:read")
  list(
    @Query(new ZodValidationPipe(listRecurringBillsQuerySchema)) query: ListRecurringBillsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.listTemplates(u.orgId, query);
  }

  @Get(":templateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:read")
  getOne(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.getTemplate(u.orgId, templateId);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:manage")
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createRecurringBillSchema)) body: CreateRecurringBillInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.createTemplate(u.orgId, u.userId, body);
  }

  @Patch(":templateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:manage")
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body(new ZodValidationPipe(updateRecurringBillSchema)) body: UpdateRecurringBillInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.updateTemplate(u.orgId, u.userId, templateId, body);
  }

  @Delete(":templateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:manage")
  @HttpCode(200)
  remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteTemplate(u.orgId, u.userId, templateId);
  }

  @Post(":templateId/run-now")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:manage")
  @HttpCode(200)
  runNow(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.runNow(u.orgId, u.userId, templateId);
  }
}
