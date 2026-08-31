import { Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { SystemAccountsService } from "./system-accounts.service";
import {
  systemAccountPurposeSchema,
  upsertSystemAccountSchema,
  type SystemAccountPurpose,
  type UpsertSystemAccountInput,
} from "./dto/settings.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const purposeParams = z.object({ purpose: systemAccountPurposeSchema }).strict();

@RequireModule("accounting")
@Controller("accounting/settings/system-accounts")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SystemAccountsController {
  constructor(private readonly svc: SystemAccountsService) {}

  @Get()
  @RequirePermission("accounting:settings:read")
  listSystemAccounts(@CurrentUser() u: CurrentUserContext) {
    return this.svc.listSystemAccounts(u.orgId);
  }

  @Put(":purpose")
  @RequirePermission("accounting:settings:manage")
  @Validate({ params: purposeParams, body: upsertSystemAccountSchema })
  upsertSystemAccount(
    @Param("purpose") purpose: SystemAccountPurpose,
    @Body() body: UpsertSystemAccountInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.svc.upsertSystemAccount(u, purpose, body);
  }
}
