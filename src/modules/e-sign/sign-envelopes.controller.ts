import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
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
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { readRequestScope } from "../organization/core/read-request-scope";
import { SignEnvelopesService } from "./sign-envelopes.service";
import {
  createEnvelopeSchema,
  updateEnvelopeSchema,
  listEnvelopesSchema,
  voidEnvelopeSchema,
  correctEnvelopeSchema,
  extendExpirationSchema,
  type CreateEnvelopeInput,
  type UpdateEnvelopeInput,
  type ListEnvelopesInput,
  type VoidEnvelopeInput,
  type CorrectEnvelopeInput,
  type ExtendExpirationInput,
} from "./dto/e-sign.schemas";

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(",")[0]?.trim() || req.ip)?.slice(0, 100);
}

function actorFrom(u: CurrentUserContext, req: Request) {
  return { orgId: u.orgId, userId: u.userId, ipAddress: clientIp(req), userAgent: req.headers["user-agent"] };
}

const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign/envelopes")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignEnvelopesController {
  constructor(private readonly envelopes: SignEnvelopesService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("sign:envelope:create")
  @Validate({ body: createEnvelopeSchema })
  create(@Body() body: CreateEnvelopeInput, @CurrentUser() u: CurrentUserContext) {
    return this.envelopes.create(u.orgId, u.userId, body);
  }

  @Get()
  @RequirePermission("sign:envelope:view")
  @Validate({ query: listEnvelopesSchema })
  list(
    @Query() query: ListEnvelopesInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const viewAll = readRequestScope(req) === "all";
    return this.envelopes.list(u.orgId, query, { userId: u.userId, viewAll });
  }

  @Get(":envelopeId")
  @RequirePermission("sign:envelope:view")
  @Validate({ params: envelopeIdParams })
  get(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    return this.envelopes.getFull(u.orgId, envelopeId);
  }

  @Patch(":envelopeId")
  @RequirePermission("sign:envelope:create")
  @Validate({ params: envelopeIdParams, body: updateEnvelopeSchema })
  update(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: UpdateEnvelopeInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.envelopes.update(u.orgId, envelopeId, body, actorFrom(u, req));
  }

  @Delete(":envelopeId")
  @RequirePermission("sign:envelope:create")
  @Validate({ params: envelopeIdParams })
  remove(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.envelopes.delete(u.orgId, envelopeId, actorFrom(u, req));
  }

  @Post(":envelopeId/validate")
  @RequirePermission("sign:envelope:create")
  @Validate({ params: envelopeIdParams })
  validate(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    return this.envelopes.validate(u.orgId, envelopeId);
  }

  @Post(":envelopeId/send")
  @Idempotent("sign:envelope.send")
  @RequirePermission("sign:envelope:send")
  @Validate({ params: envelopeIdParams })
  send(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.envelopes.send(u.orgId, envelopeId, actorFrom(u, req));
  }

  @Post(":envelopeId/void")
  @Idempotent("sign:envelope.void")
  @RequirePermission("sign:envelope:void")
  @Validate({ params: envelopeIdParams, body: voidEnvelopeSchema })
  voidEnvelope(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: VoidEnvelopeInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.envelopes.voidEnvelope(u.orgId, envelopeId, body, actorFrom(u, req));
  }

  @Post(":envelopeId/correct")
  @Idempotent("sign:envelope.correct")
  @RequirePermission("sign:envelope:correct")
  @Validate({ params: envelopeIdParams, body: correctEnvelopeSchema })
  correct(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: CorrectEnvelopeInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.envelopes.correct(u.orgId, envelopeId, body, actorFrom(u, req));
  }

  @Post(":envelopeId/resend")
  @Idempotent("sign:envelope.resend")
  @RequirePermission("sign:envelope:send")
  @Validate({ params: envelopeIdParams })
  resend(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.envelopes.resend(u.orgId, envelopeId, actorFrom(u, req));
  }

  @Post(":envelopeId/send-reminder")
  @Idempotent("sign:envelope.send_reminder")
  @RequirePermission("sign:envelope:send")
  @Validate({ params: envelopeIdParams })
  sendReminder(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.envelopes.sendManualReminder(u.orgId, envelopeId, actorFrom(u, req));
  }

  @Post(":envelopeId/extend-expiration")
  @RequirePermission("sign:envelope:correct")
  @Validate({ params: envelopeIdParams, body: extendExpirationSchema })
  extendExpiration(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: ExtendExpirationInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.envelopes.extendExpiration(u.orgId, envelopeId, body, actorFrom(u, req));
  }
}
