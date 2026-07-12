import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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
} from "./dto/signos.schemas";

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(",")[0]?.trim() || req.ip)?.slice(0, 100);
}

function actorFrom(u: CurrentUserContext, req: Request) {
  return { orgId: u.orgId, userId: u.userId, ipAddress: clientIp(req), userAgent: req.headers["user-agent"] };
}

@RequireModule("sign")
@Controller("sign/envelopes")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignEnvelopesController {
  constructor(private readonly envelopes: SignEnvelopesService) {}

  @Post()
  @RequirePermission("sign:envelope:create")
  create(@Body(new ZodValidationPipe(createEnvelopeSchema)) body: CreateEnvelopeInput, @CurrentUser() u: CurrentUserContext) {
    return this.envelopes.create(u.orgId, u.userId, body);
  }

  @Get()
  @RequirePermission("sign:envelope:view")
  list(@Query(new ZodValidationPipe(listEnvelopesSchema)) query: ListEnvelopesInput, @CurrentUser() u: CurrentUserContext) {
    const viewAll = u.isOrgOwner || u.isPlatformAdmin || u.permissions.includes("sign:envelope:view_all");
    return this.envelopes.list(u.orgId, query, { userId: u.userId, viewAll });
  }

  @Get(":id")
  @RequirePermission("sign:envelope:view")
  get(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.envelopes.getFull(u.orgId, id);
  }

  @Patch(":id")
  @RequirePermission("sign:envelope:create")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updateEnvelopeSchema)) body: UpdateEnvelopeInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.envelopes.update(u.orgId, id, body, actorFrom(u, req));
  }

  @Post(":id/validate")
  @RequirePermission("sign:envelope:create")
  validate(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.envelopes.validate(u.orgId, id);
  }

  @Post(":id/send")
  @RequirePermission("sign:envelope:send")
  send(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.envelopes.send(u.orgId, id, actorFrom(u, req));
  }

  @Post(":id/void")
  @RequirePermission("sign:envelope:void")
  voidEnvelope(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(voidEnvelopeSchema)) body: VoidEnvelopeInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.envelopes.voidEnvelope(u.orgId, id, body, actorFrom(u, req));
  }

  @Post(":id/correct")
  @RequirePermission("sign:envelope:correct")
  correct(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(correctEnvelopeSchema)) body: CorrectEnvelopeInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.envelopes.correct(u.orgId, id, body, actorFrom(u, req));
  }

  @Post(":id/resend")
  @RequirePermission("sign:envelope:send")
  resend(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.envelopes.resend(u.orgId, id, actorFrom(u, req));
  }

  @Post(":id/extend-expiration")
  @RequirePermission("sign:envelope:correct")
  extendExpiration(
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(extendExpirationSchema)) body: ExtendExpirationInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.envelopes.extendExpiration(u.orgId, id, body, actorFrom(u, req));
  }
}
