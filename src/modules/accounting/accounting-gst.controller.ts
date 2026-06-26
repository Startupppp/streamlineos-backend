import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AccountingGstService } from "./accounting-gst.service";
import {
  gstr1QuerySchema,
  gstr3BQuerySchema,
  type Gstr1Query,
  type Gstr3BQuery,
} from "./dto/accounting.schemas";

@Controller("accounting/reports")
@UseGuards(JwtAuthGuard)
export class AccountingGstController {
  constructor(private readonly gst: AccountingGstService) {}

  @Get("gstr-1")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  gstr1(
    @Query(new ZodValidationPipe(gstr1QuerySchema)) query: Gstr1Query,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.gst.gstr1(u.orgId, query);
  }

  @Get("gstr-3b")
  @UseGuards(AbilityGuard)
  @CheckAbility("read", "accounting:reports")
  gstr3b(
    @Query(new ZodValidationPipe(gstr3BQuerySchema)) query: Gstr3BQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.gst.gstr3b(u.orgId, query);
  }
}
