import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { KbArticleMigrationService } from "./kb-article-migration.service";
import {
  runArticleMigrationSchema,
  type RunArticleMigrationInput,
} from "./dto/kb-article-migration.schemas";

@Controller("kb/article-migration")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
@RequireModule("kb")
export class KbArticleMigrationController {
  constructor(private readonly service: KbArticleMigrationService) {}

  @Get("preview")
  @RequirePermission("kb:settings:manage")
  async preview(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.service.preview(u.orgId);
  }

  @Post("run")
  @RequirePermission("kb:settings:manage")
  async run(
    @Body(new ZodValidationPipe(runArticleMigrationSchema)) body: RunArticleMigrationInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.run(u, body);
  }
}
