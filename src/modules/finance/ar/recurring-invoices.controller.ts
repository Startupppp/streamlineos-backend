import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import {
  createRecurringTemplateSchema,
  updateRecurringTemplateSchema,
  listRecurringTemplatesSchema,
  type CreateRecurringTemplateInput,
  type UpdateRecurringTemplateInput,
  type ListRecurringTemplatesQuery,
} from "./dto/finance-ar.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import {
  recurringInvoiceListResponseSchema,
  recurringInvoiceTemplateResponseSchema,
  recurringInvoiceRunNowResponseSchema,
  recurringInvoiceDeleteResponseSchema,
} from "./dto/ar-response.schemas";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/recurring-invoices")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class RecurringInvoicesController {
  constructor(private readonly svc: RecurringInvoicesService) {}

  @Get()
  @ResponseSchema(recurringInvoiceListResponseSchema)
  @RequirePermission("accounting:recurring:read")
  @Validate({ query: listRecurringTemplatesSchema })
  list(
    @Query() query: ListRecurringTemplatesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.list(u.orgId, query);
  }

  @Post()
  @ResponseSchema(recurringInvoiceTemplateResponseSchema)
  @HttpCode(201)
  @RequirePermission("accounting:recurring:manage")
  @Validate({ body: createRecurringTemplateSchema })
  create(
    @Body() body: CreateRecurringTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.create(u.orgId, u.userId, body);
  }

  @Get(":templateId")
  @ResponseSchema(recurringInvoiceTemplateResponseSchema)
  @RequirePermission("accounting:recurring:read")
  @Validate({ params: templateIdParams })
  get(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.get(u.orgId, templateId);
  }

  @Patch(":templateId")
  @ResponseSchema(recurringInvoiceTemplateResponseSchema)
  @RequirePermission("accounting:recurring:manage")
  @Validate({ params: templateIdParams, body: updateRecurringTemplateSchema })
  update(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: UpdateRecurringTemplateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.update(u.orgId, u.userId, templateId, body);
  }

  @Delete(":templateId")
  @ResponseSchema(recurringInvoiceDeleteResponseSchema)
  @RequirePermission("accounting:recurring:manage")
  @Validate({ params: templateIdParams })
  remove(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.delete(u.orgId, u.userId, templateId);
  }

  @Post(":templateId/run-now")
  @ResponseSchema(recurringInvoiceRunNowResponseSchema)
  @BodylessAction()
  @Idempotent("finance.recurring-invoice.run-now")
  @HttpCode(200)
  @RequirePermission("accounting:recurring:manage")
  @Validate({ params: templateIdParams })
  runNow(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.runNow(u.orgId, u.userId, templateId);
  }
}
