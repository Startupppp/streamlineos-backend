import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbVerificationService } from "./kb-verification.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbVerificationQueueSchema } from "./dto/kb-helpcenter-response.schemas";
import { verificationQueueSchema, type VerificationQueueInput } from "./dto/kb-helpcenter.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbVerificationController {
  constructor(private readonly verification: KbVerificationService) {}

  @Get("verification/queue")
  @RequirePermission("kb:articles:manage")
  @Validate({ query: verificationQueueSchema })
  @ResponseSchema(kbVerificationQueueSchema)
  async listDue(
    @Query() query: VerificationQueueInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.verification.listDue(u, query.page, query.pageSize);
  }
}
