import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { CategorizeSuggestService } from "./categorize-suggest.service";
import { categorizeSuggestSchema, type CategorizeSuggestInput } from "./dto/categorize-suggest.schemas";
import { Validate } from "../../../common/validation/validate.decorator";

@RequireModule("accounting")
@Controller("accounting/expenses")
@UseGuards(JwtAuthGuard)
export class CategorizeSuggestController {
  constructor(private readonly suggester: CategorizeSuggestService) {}

  @Post("categorize-suggest")
  @HttpCode(200)
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:reimbursements:read")
  @Validate({ body: categorizeSuggestSchema })
  suggest(
    @Body() body: CategorizeSuggestInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.suggester.suggest(u.orgId, body);
  }
}
