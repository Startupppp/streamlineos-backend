import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CollectionsService } from "./collections.service";
import {
  listCollectionActivitiesSchema,
  createCollectionActivitySchema,
  updateInvoiceCollectionSchema,
  type ListCollectionActivitiesQuery,
  type CreateCollectionActivityInput,
  type UpdateInvoiceCollectionInput,
} from "./dto/finance-ar.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const invoiceIdParams = z.object({ invoiceId: z.coerce.number().int().positive() }).strict();

@RequireModule("accounting")
@Controller("accounting/collections")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CollectionsController {
  constructor(private readonly svc: CollectionsService) {}

  @Get("summary")
  @RequirePermission("accounting:collections:read")
  summary(@CurrentUser() u: CurrentUserContext) {
    return this.svc.summary(u.orgId);
  }

  @Get("activities")
  @RequirePermission("accounting:collections:read")
  @Validate({ query: listCollectionActivitiesSchema })
  listActivities(
    @Query() query: ListCollectionActivitiesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.listActivities(u.orgId, query);
  }

  @Post("activities")
  @HttpCode(201)
  @RequirePermission("accounting:collections:manage")
  @Validate({ body: createCollectionActivitySchema })
  createActivity(
    @Body() body: CreateCollectionActivityInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.createActivity(u.orgId, u.userId, body);
  }

  @Patch("invoices/:invoiceId")
  @RequirePermission("accounting:collections:manage")
  @Validate({ params: invoiceIdParams, body: updateInvoiceCollectionSchema })
  updateInvoiceCollection(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @Body() body: UpdateInvoiceCollectionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.updateInvoiceCollection(u.orgId, u.userId, invoiceId, body);
  }
}
