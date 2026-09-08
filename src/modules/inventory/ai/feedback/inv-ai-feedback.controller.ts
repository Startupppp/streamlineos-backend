import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ModuleGuard } from "../../../../common/rbac/module.guard";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { ZodValidationPipe } from "../../../../common/pipes/zod-validation.pipe";
import { InvAiFeedbackService } from "./inv-ai-feedback.service";
import {
  createInvAiFeedbackSchema,
  invAiFeedbackSummaryQuerySchema,
  type CreateInvAiFeedbackInput,
  type InvAiFeedbackSummaryQuery,
} from "./dto/inv-ai-feedback.schemas";
import { Idempotent } from "../../../../common/idempotency/idempotent.decorator";

/**
 * F6 — filing a verdict, and reading the aggregate.
 *
 * Filing is `inventory:ai:read`: if you were allowed to see the answer, you are
 * allowed to say it was wrong. Gating a complaint behind a management key is how
 * a system stops hearing about its own failures.
 *
 * Reading the aggregate is `inventory:ai:manage`, because the summary is about
 * how the organisation's AI surfaces are performing rather than about any one
 * answer, and because `unsafeTotal` is the sort of number that belongs with the
 * people who can act on it.
 *
 * Neither route reaches a provider, so neither carries the `ai:invoke` limit and
 * neither spends credits. Filing feedback about an expensive answer must not
 * itself be expensive.
 */
@RequireModule("inventory")
@Controller("inventory/ai/feedback")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class InvAiFeedbackController {
  constructor(private readonly feedback: InvAiFeedbackService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:ai:read")
  @Idempotent("inventory.ai.feedback.submit")
  @HttpCode(HttpStatus.CREATED)
  submit(
    @Body(new ZodValidationPipe(createInvAiFeedbackSchema)) body: CreateInvAiFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.feedback.submit(u, body);
  }

  @Get("summary")
  @UseGuards(PermissionGuard)
  @RequirePermission("inventory:ai:manage")
  summary(
    @Query(new ZodValidationPipe(invAiFeedbackSummaryQuerySchema)) query: InvAiFeedbackSummaryQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.feedback.summary(u.orgId, query);
  }
}
