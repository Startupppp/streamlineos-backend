import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbAskService } from "./kb-ask.service";
import { askSchema, type AskInput } from "./dto/kb-ai.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbAskController {
  constructor(private readonly ask: KbAskService) {}

  @Post("ask")
  @HttpCode(200)
  @RequirePermission("kb:ai:generate")
  async askQuestion(
    @Body(new ZodValidationPipe(askSchema)) body: AskInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.ask.ask(u, body);
  }
}
