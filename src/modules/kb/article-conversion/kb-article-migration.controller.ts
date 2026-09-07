import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Idempotent } from "../../../common/idempotency/idempotent.decorator";
import { KbArticleMigrationService } from "./kb-article-migration.service";
import {
  runArticleMigrationSchema,
  type RunArticleMigrationInput,
} from "./dto/kb-article-migration.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbMigrationPreviewSchema, kbMigrationRunSchema } from "./dto/kb-migration-response.schemas";

@Controller("kb/article-migration")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbArticleMigrationController {
  constructor(private readonly service: KbArticleMigrationService) {}

  @Get("preview")
  @RequirePermission("kb:settings:manage")
  @ResponseSchema(kbMigrationPreviewSchema)
  async preview(@CurrentUser() u: CurrentUserContext): Promise<unknown> {
    return this.service.preview(u.orgId);
  }

  @Post("run")
  @Idempotent("kb:article_migration.run")
  @RequirePermission("kb:settings:manage")
  @Validate({ body: runArticleMigrationSchema })
  @ResponseSchema(kbMigrationRunSchema)
  async run(
    @Body() body: RunArticleMigrationInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return this.service.run(u, body);
  }
}
