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
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { RecurringBillsService } from "./recurring-bills.service";
import {
  createRecurringBillSchema,
  updateRecurringBillSchema,
  listRecurringBillsQuerySchema,
  type CreateRecurringBillInput,
  type UpdateRecurringBillInput,
  type ListRecurringBillsQuery,
} from "./dto/finance-ap.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

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
  @Validate({ params: templateIdParams })
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
  @Validate({ params: templateIdParams })
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
  @Validate({ params: templateIdParams })
  remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.deleteTemplate(u.orgId, u.userId, templateId);
  }

  @Post(":templateId/run-now")
  @Idempotent("finance.recurring-bill.run-now")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:manage")
  @HttpCode(200)
  @Validate({ params: templateIdParams })
  runNow(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.service.runNow(u.orgId, u.userId, templateId);
  }
}
