import { Body, Controller, HttpCode, Post, UseGuards, UseInterceptors } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { AiRequestAbortInterceptor } from "../../ai/core/streaming";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KbAuthoringService } from "./kb-authoring.service";
import {
  draftSchema,
  improveSchema,
  summarizeSchema,
  type DraftInput,
  type ImproveInput,
  type SummarizeInput,
} from "./dto/kb-authoring.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { kbAuthoringContentSchema } from "./dto/kb-helpcenter-response.schemas";

@Controller("kb/ai")
@UseGuards(JwtAuthGuard, PermissionGuard)
@UseInterceptors(AiRequestAbortInterceptor)
export class KbAuthoringController {
  constructor(private readonly authoring: KbAuthoringService) {}

  @Post("draft")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:ai:generate")
  @Validate({ body: draftSchema })
  @ResponseSchema(kbAuthoringContentSchema)
  async draft(
    @Body() body: DraftInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.authoring.draft(u, body);
  }

  @Post("improve")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:ai:generate")
  @Validate({ body: improveSchema })
  @ResponseSchema(kbAuthoringContentSchema)
  async improve(
    @Body() body: ImproveInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.authoring.improve(u, body);
  }

  @Post("summarize")
  @HttpCode(200)
  @NoTenantTransaction()
  @RequirePermission("kb:ai:generate")
  @Validate({ body: summarizeSchema })
  @ResponseSchema(kbAuthoringContentSchema)
  async summarize(
    @Body() body: SummarizeInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<unknown> {
    return await this.authoring.summarize(u, body);
  }

}
