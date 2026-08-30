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
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Public } from "../../../common/auth/public.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RateLimitService } from "../../../common/ratelimit/rate-limit.service";
import { SupportChannelsService } from "./support-channels.service";
import { SupportSettingsAuditService } from "./support-settings-audit.service";
import {
  createSupportChannelSchema,
  inboundEmailSchema,
  inboundSmsSchema,
  inboundWhatsAppSchema,
  sendChatMessageSchema,
  startChatSessionSchema,
  updateSupportChannelSchema,
  type CreateSupportChannelInput,
  type InboundEmailInput,
  type InboundSmsInput,
  type InboundWhatsAppInput,
  type SendChatMessageInput,
  type StartChatSessionInput,
  type UpdateSupportChannelInput,
} from "./dto/support.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();
const orgIdParams = z.object({ orgId: z.string().min(1) }).strict();
const orgIdsessionTokenParams = z.object({ orgId: z.string().min(1), sessionToken: z.string().min(1) }).strict();

@RequireModule("support")
@Controller("support")
export class SupportChannelsController {
  constructor(
    private readonly channels: SupportChannelsService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: SupportSettingsAuditService,
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
  async createChannel(
    @Body(new ZodValidationPipe(createSupportChannelSchema)) body: CreateSupportChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.channels.createChannel(u.orgId, body);
    await this.audit.record(u.orgId, u.userId, "channel", result.id, "created", { ...body, config: undefined });
    return result;
  }

  @Patch("channels/:channelId")
  @UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
  @RequirePermission("support:channels:manage")
  @Validate({ params: channelIdParams })
  async updateChannel(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(updateSupportChannelSchema)) body: UpdateSupportChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const result = await this.channels.updateChannel(u.orgId, channelId, body);
    await this.audit.record(u.orgId, u.userId, "channel", channelId, "updated", { ...body, config: undefined });
    return result;
  }

  @Delete("channels/:channelId")
  @UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
  @RequirePermission("support:channels:manage")
  @Validate({ params: channelIdParams })
  async deleteChannel(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    const result = await this.channels.deleteChannel(u.orgId, channelId);
    await this.audit.record(u.orgId, u.userId, "channel", channelId, "deleted");
    return result;
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
  @Validate({ params: orgIdParams })
  async inboundEmail(
    @Param("orgId") orgId: string,
    @Headers("x-webhook-secret") secret: string | undefined,
    @Body(new ZodValidationPipe(inboundEmailSchema)) body: InboundEmailInput,
  ) {
    const rate = await this.rateLimit.check("support:inbound-email", orgId);
    if (!rate.allowed) {
      throw new HttpException("Too many inbound emails", HttpStatus.TOO_MANY_REQUESTS);
    }

    const channel = await this.channels.verifyInboundSecret(orgId, "email", secret);
    return this.channels.ingestInboundEmail(orgId, channel, body);
  }

  /** Same trust model as inboundEmail — the WhatsApp Business API webhook relay posts here directly. */
  @Public()
  @Post("inbound/whatsapp/:orgId")
  @HttpCode(200)
  @Validate({ params: orgIdParams })
  async inboundWhatsApp(
    @Param("orgId") orgId: string,
    @Headers("x-webhook-secret") secret: string | undefined,
    @Body(new ZodValidationPipe(inboundWhatsAppSchema)) body: InboundWhatsAppInput,
  ) {
    const rate = await this.rateLimit.check("support:inbound-whatsapp", orgId);
    if (!rate.allowed) {
      throw new HttpException("Too many inbound WhatsApp messages", HttpStatus.TOO_MANY_REQUESTS);
    }

    const channel = await this.channels.verifyInboundSecret(orgId, "whatsapp", secret);
    return this.channels.ingestInboundWhatsApp(orgId, channel, body);
  }

  /** Same trust model as inboundEmail — the SMS provider (e.g. Twilio) webhook posts here directly. */
  @Public()
  @Post("inbound/sms/:orgId")
  @HttpCode(200)
  @Validate({ params: orgIdParams })
  async inboundSms(
    @Param("orgId") orgId: string,
    @Headers("x-webhook-secret") secret: string | undefined,
    @Body(new ZodValidationPipe(inboundSmsSchema)) body: InboundSmsInput,
  ) {
    const rate = await this.rateLimit.check("support:inbound-sms", orgId);
    if (!rate.allowed) {
      throw new HttpException("Too many inbound SMS messages", HttpStatus.TOO_MANY_REQUESTS);
    }

    const channel = await this.channels.verifyInboundSecret(orgId, "sms", secret);
    return this.channels.ingestInboundSms(orgId, channel, body);
  }

  /**
   * Live chat widget endpoints — public, called directly from the visitor's
   * browser (no webhook secret model; a per-conversation sessionToken is
   * generated on start and must be presented on every subsequent call).
   */
  @Public()
  @Post("chat/:orgId/start")
  @HttpCode(201)
  @Validate({ params: orgIdParams })
  async startChatSession(
    @Param("orgId") orgId: string,
    @Body(new ZodValidationPipe(startChatSessionSchema)) body: StartChatSessionInput,
  ) {
    const rate = await this.rateLimit.check("support:chat-widget", orgId);
    if (!rate.allowed) {
      throw new HttpException("Too many chat sessions", HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.channels.startChatSession(orgId, body);
  }

  @Public()
  @Get("chat/:orgId/:sessionToken/messages")
  @Validate({ params: orgIdsessionTokenParams })
  async getChatSession(@Param("orgId") orgId: string, @Param("sessionToken") sessionToken: string) {
    return this.channels.getChatSession(orgId, sessionToken);
  }

  @Public()
  @Post("chat/:orgId/:sessionToken/messages")
  @HttpCode(201)
  @Validate({ params: orgIdsessionTokenParams })
  async sendChatMessage(
    @Param("orgId") orgId: string,
    @Param("sessionToken") sessionToken: string,
    @Body(new ZodValidationPipe(sendChatMessageSchema)) body: SendChatMessageInput,
  ) {
    const rate = await this.rateLimit.check("support:chat-widget", `${orgId}:${sessionToken}`);
    if (!rate.allowed) {
      throw new HttpException("Too many messages", HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.channels.sendChatMessage(orgId, sessionToken, body);
  }
}
