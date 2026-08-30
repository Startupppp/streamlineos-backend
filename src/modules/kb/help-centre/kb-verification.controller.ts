import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbVerificationService } from "./kb-verification.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

const verificationQueueSchema = z.object({
  page: pageNumberField,
  pageSize: pageSizeField(20, 100),
});

type VerificationQueueInput = z.infer<typeof verificationQueueSchema>;

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequireModule("kb")
export class KbVerificationController {
  constructor(private readonly verification: KbVerificationService) {}

  @Get("verification/queue")
  @RequirePermission("kb:articles:manage")
  @Validate({ query: verificationQueueSchema })
  async listDue(
    @Query() query: VerificationQueueInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.verification.listDue(u, query.page, query.pageSize);
  }
}
