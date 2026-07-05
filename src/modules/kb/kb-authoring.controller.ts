import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbAuthoringService } from "./kb-authoring.service";
import {
  draftSchema,
  improveSchema,
  summarizeSchema,
  type DraftInput,
  type ImproveInput,
  type SummarizeInput,
} from "./dto/kb-authoring.schemas";

@Controller("kb/ai")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbAuthoringController {
  constructor(private readonly authoring: KbAuthoringService) {}

  @Post("draft")
  @HttpCode(200)
  @RequirePermission("kb:ai:generate")
  async draft(
    @Body(new ZodValidationPipe(draftSchema)) body: DraftInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.authoring.draft(u.orgId, u.userId, body);
  }

  @Post("improve")
  @HttpCode(200)
  @RequirePermission("kb:ai:generate")
  async improve(
    @Body(new ZodValidationPipe(improveSchema)) body: ImproveInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.authoring.improve(u.orgId, u.userId, body);
  }

  @Post("summarize")
  @HttpCode(200)
  @RequirePermission("kb:ai:generate")
  async summarize(
    @Body(new ZodValidationPipe(summarizeSchema)) body: SummarizeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.authoring.summarize(u.orgId, u.userId, body);
  }

}
