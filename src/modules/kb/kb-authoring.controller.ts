import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbAuthoringService } from "./kb-authoring.service";
import {
  draftSchema,
  improveSchema,
  summarizeSchema,
  translateSchema,
  type DraftInput,
  type ImproveInput,
  type SummarizeInput,
  type TranslateInput,
} from "./dto/kb-authoring.schemas";

@Controller("kb/ai")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbAuthoringController {
  constructor(private readonly authoring: KbAuthoringService) {}

  @Post("draft")
  @HttpCode(200)
  @RequirePermission("kb:ai:generate")
  draft(
    @Body(new ZodValidationPipe(draftSchema)) body: DraftInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.authoring.draft(u.orgId, u.userId, body);
  }

  @Post("improve")
  @HttpCode(200)
  @RequirePermission("kb:ai:generate")
  improve(
    @Body(new ZodValidationPipe(improveSchema)) body: ImproveInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.authoring.improve(u.orgId, u.userId, body);
  }

  @Post("summarize")
  @HttpCode(200)
  @RequirePermission("kb:ai:generate")
  summarize(
    @Body(new ZodValidationPipe(summarizeSchema)) body: SummarizeInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.authoring.summarize(u.orgId, u.userId, body);
  }

  @Post("translate")
  @HttpCode(200)
  @RequirePermission("kb:ai:generate")
  translate(
    @Body(new ZodValidationPipe(translateSchema)) body: TranslateInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.authoring.translate(u.orgId, u.userId, body);
  }
}
