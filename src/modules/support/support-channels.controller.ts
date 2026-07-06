import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Public } from "../../common/auth/public.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { SupportChannelsService } from "./support-channels.service";
import {
  createSupportChannelSchema,
  inboundEmailSchema,
  updateSupportChannelSchema,
  type CreateSupportChannelInput,
  type InboundEmailInput,
  type UpdateSupportChannelInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../common/rbac/module.guard";

@RequireModule("support")
@Controller("support")
export class SupportChannelsController {
  constructor(
    private readonly channels: SupportChannelsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get("channels")
  @UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
  @RequirePermission("support:channels:manage")
  listChannels(@CurrentUser() u: CurrentUserContext) {
    return this.channels.listChannels(u.orgId);
  }

  @Post("channels")
  @UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
  @RequirePermission("support:channels:manage")
  @HttpCode(201)
  createChannel(
    @Body(new ZodValidationPipe(createSupportChannelSchema)) body: CreateSupportChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.createChannel(u.orgId, body);
  }

  @Patch("channels/:id")
  @UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
  @RequirePermission("support:channels:manage")
  updateChannel(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateSupportChannelSchema)) body: UpdateSupportChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.updateChannel(u.orgId, id, body);
  }

  @Delete("channels/:id")
  @UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
  @RequirePermission("support:channels:manage")
  deleteChannel(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.channels.deleteChannel(u.orgId, id);
  }

  /**
   * Public, unauthenticated receiver — the org's inbound email relay posts
   * here directly (no logged-in user to derive a JWT from). orgId is embedded
   * in the URL path — the relay is configured with this URL once, so orgId
   * is trusted the same way payment-webhooks-public.controller.ts trusts its
   * path-embedded orgId, rather than accepted from a spoofable header.
   * Every request still MUST pass the per-org shared secret check below
   * before any DB write.
   */
  @Public()
  @Post("inbound/email/:orgId")
  @HttpCode(200)
  async inboundEmail(
    @Param("orgId") orgId: string,
    @Headers("x-webhook-secret") secret: string | undefined,
    @Body(new ZodValidationPipe(inboundEmailSchema)) body: InboundEmailInput,
  ) {
    const rate = await this.rateLimit.check("support:inbound-email", orgId);
    if (!rate.allowed) {
      throw new HttpException("Too many inbound emails", HttpStatus.TOO_MANY_REQUESTS);
    }

    const channel = await this.channels.verifyInboundSecret(orgId, secret);
    return this.channels.ingestInboundEmail(orgId, channel, body);
  }
}
