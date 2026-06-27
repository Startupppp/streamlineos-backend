import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AbilityGuard } from "../../common/rbac/ability.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { CheckAbility } from "../../common/rbac/check-ability.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbAskService } from "./kb-ask.service";
import { askSchema, type AskInput } from "./dto/kb-ai.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, ModuleGuard, AbilityGuard)
@RequireModule("kb")
export class KbAskController {
  constructor(private readonly ask: KbAskService) {}

  @Post("ask")
  @HttpCode(200)
  @CheckAbility("generate", "kb:ai")
  askQuestion(
    @Body(new ZodValidationPipe(askSchema)) body: AskInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.ask.ask(u, body);
  }
}
