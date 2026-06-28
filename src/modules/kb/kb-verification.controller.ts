import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbVerificationService } from "./kb-verification.service";
import { z } from "zod";

const verificationQueueSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

type VerificationQueueInput = z.infer<typeof verificationQueueSchema>;

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbVerificationController {
  constructor(private readonly verification: KbVerificationService) {}

  @Get("verification/queue")
  @RequirePermission("kb:articles:manage")
  listDue(
    @Query(new ZodValidationPipe(verificationQueueSchema)) query: VerificationQueueInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.verification.listDue(u, query.page, query.pageSize);
  }
}
