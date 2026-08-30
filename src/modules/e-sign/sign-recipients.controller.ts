import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SignRecipientsService } from "./sign-recipients.service";
import {
  createRecipientSchema,
  updateRecipientSchema,
  type CreateRecipientInput,
  type UpdateRecipientInput,
} from "./dto/e-sign.schemas";

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(",")[0]?.trim() || req.ip)?.slice(0, 100);
}

const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();
const recipientIdParams = z.object({ recipientId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignRecipientsController {
  constructor(private readonly recipients: SignRecipientsService) {}

  @Post("envelopes/:envelopeId/recipients")
  @HttpCode(201)
  @RequirePermission("sign:envelope:create")
  @Validate({ params: envelopeIdParams })
  add(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body(new ZodValidationPipe(createRecipientSchema)) body: CreateRecipientInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.recipients.add(u.orgId, envelopeId, body, { orgId: u.orgId, userId: u.userId, ipAddress: clientIp(req) });
  }

  @Get("envelopes/:envelopeId/recipients")
  @RequirePermission("sign:envelope:view")
  @Validate({ params: envelopeIdParams })
  list(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    return this.recipients.listForEnvelope(u.orgId, envelopeId);
  }

  @Patch("recipients/:recipientId")
  @RequirePermission("sign:envelope:create")
  @Validate({ params: recipientIdParams })
  update(
    @Param("recipientId", ParseIntPipe) recipientId: number,
    @Body(new ZodValidationPipe(updateRecipientSchema)) body: UpdateRecipientInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.recipients.update(u.orgId, recipientId, body, { orgId: u.orgId, userId: u.userId, ipAddress: clientIp(req) });
  }

  @Delete("recipients/:recipientId")
  @RequirePermission("sign:envelope:create")
  @Validate({ params: recipientIdParams })
  async remove(@Param("recipientId", ParseIntPipe) recipientId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    await this.recipients.remove(u.orgId, recipientId, { orgId: u.orgId, userId: u.userId, ipAddress: clientIp(req) });
    return { success: true };
  }
}
