import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RecurringJournalsService } from "./recurring-journals.service";
import {
  createRecurringJournalSchema,
  listRecurringJournalsQuerySchema,
  updateRecurringJournalSchema,
  type CreateRecurringJournalInput,
  type ListRecurringJournalsQuery,
  type UpdateRecurringJournalInput,
} from "./dto/recurring-journals.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const templateIdParams = z.object({ templateId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/recurring-journals")
@UseGuards(JwtAuthGuard)
export class RecurringJournalsController {
  constructor(private readonly recurring: RecurringJournalsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:read")
  @Validate({ query: listRecurringJournalsQuerySchema })
  listTemplates(
    @Query() query: ListRecurringJournalsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recurring.listTemplates(u.orgId, query.page, query.pageSize);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:manage")
  @HttpCode(201)
  @Validate({ body: createRecurringJournalSchema })
  createTemplate(
    @Body() body: CreateRecurringJournalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recurring.createTemplate(u.orgId, u.userId, body);
  }

  @Patch(":templateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:manage")
  @Validate({ params: templateIdParams, body: updateRecurringJournalSchema })
  updateTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @Body() body: UpdateRecurringJournalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recurring.updateTemplate(u.orgId, templateId, body);
  }

  @Delete(":templateId")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:manage")
  @HttpCode(200)
  @Validate({ params: templateIdParams })
  deleteTemplate(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recurring.deleteTemplate(u.orgId, templateId);
  }

  @Post(":templateId/run-now")
  @Idempotent("accounting.recurring-journal.run-now")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:recurring:manage")
  @HttpCode(200)
  @Validate({ params: templateIdParams })
  runNow(
    @Param("templateId", ParseIntPipe) templateId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.recurring.runNow(u.orgId, u.userId, templateId);
  }
}
