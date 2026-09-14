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
import { actingMembershipId } from "../../common/auth/principal";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { readRequestScopedRead } from "../organization/core/read-request-scope";
import { SignEnvelopesService } from "./sign-envelopes.service";
import { SignEnvelopeAccessService } from "./sign-envelope-access.service";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { successSchema } from "../../common/openapi/response-envelopes";
import {
  envelopeMutationResponseSchema,
  listEnvelopesResponseSchema,
  getEnvelopeFullResponseSchema,
  validateEnvelopeResponseSchema,
  resendEnvelopeResponseSchema,
  sendReminderResponseSchema,
} from "./dto/e-sign-response.schemas";
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
import { resolveClientIp } from "../../common/http/client-ip";


function actorFrom(u: CurrentUserContext, req: Request) {
  return { orgId: u.orgId, userId: u.userId, membershipId: actingMembershipId(u.principal), ipAddress: resolveClientIp(req), userAgent: req.headers["user-agent"] };
}

const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign/envelopes")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignEnvelopesController {
  constructor(
    private readonly envelopes: SignEnvelopesService,
    private readonly envelopeAccess: SignEnvelopeAccessService,
  ) {}

  @Post()
  @HttpCode(201)
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(envelopeMutationResponseSchema)
  @Validate({ body: createEnvelopeSchema })
  create(@Body() body: CreateEnvelopeInput, @CurrentUser() u: CurrentUserContext) {
    return this.envelopes.create(u.orgId, actingMembershipId(u.principal), body);
  }

  @Get()
  @RequirePermission("sign:envelope:view")
  @ResponseSchema(listEnvelopesResponseSchema)
  @Validate({ query: listEnvelopesSchema })
  list(
    @Query() query: ListEnvelopesInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const read = readRequestScopedRead(req, u);
    return this.envelopes.list(read, actingMembershipId(u.principal), query);
  }

  @Get(":envelopeId")
  @RequirePermission("sign:envelope:view")
  @ResponseSchema(getEnvelopeFullResponseSchema)
  @Validate({ params: envelopeIdParams })
  get(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    const read = readRequestScopedRead(req, u);
    return this.envelopes.getFull(read, actingMembershipId(u.principal), envelopeId);
  }

  @Patch(":envelopeId")
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(envelopeMutationResponseSchema)
  @Validate({ params: envelopeIdParams, body: updateEnvelopeSchema })
  async update(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: UpdateEnvelopeInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.envelopes.update(u.orgId, envelopeId, body, actorFrom(u, req));
  }

  @Delete(":envelopeId")
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(successSchema)
  @Validate({ params: envelopeIdParams })
  async remove(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.envelopes.delete(u.orgId, envelopeId, actorFrom(u, req));
  }

  @Post(":envelopeId/validate")
  @BodylessAction()
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(validateEnvelopeResponseSchema)
  @Validate({ params: envelopeIdParams })
  async validate(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.envelopes.validate(u.orgId, envelopeId);
  }

  @Post(":envelopeId/send")
  @BodylessAction()
  @Idempotent("sign:envelope.send")
  @RequirePermission("sign:envelope:send")
  @ResponseSchema(envelopeMutationResponseSchema)
  @Validate({ params: envelopeIdParams })
  async send(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.envelopes.send(u.orgId, envelopeId, actorFrom(u, req));
  }

  @Post(":envelopeId/void")
  @Idempotent("sign:envelope.void")
  @RequirePermission("sign:envelope:void")
  @ResponseSchema(envelopeMutationResponseSchema)
  @Validate({ params: envelopeIdParams, body: voidEnvelopeSchema })
  async voidEnvelope(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: VoidEnvelopeInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.envelopes.voidEnvelope(u.orgId, envelopeId, body, actorFrom(u, req));
  }

  @Post(":envelopeId/correct")
  @Idempotent("sign:envelope.correct")
  @RequirePermission("sign:envelope:correct")
  @ResponseSchema(envelopeMutationResponseSchema)
  @Validate({ params: envelopeIdParams, body: correctEnvelopeSchema })
  async correct(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: CorrectEnvelopeInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.envelopes.correct(u.orgId, envelopeId, body, actorFrom(u, req));
  }

  @Post(":envelopeId/resend")
  @BodylessAction()
  @Idempotent("sign:envelope.resend")
  @RequirePermission("sign:envelope:send")
  @ResponseSchema(resendEnvelopeResponseSchema)
  @Validate({ params: envelopeIdParams })
  async resend(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.envelopes.resend(u.orgId, envelopeId, actorFrom(u, req));
  }

  @Post(":envelopeId/send-reminder")
  @BodylessAction()
  @Idempotent("sign:envelope.send_reminder")
  @RequirePermission("sign:envelope:send")
  @ResponseSchema(sendReminderResponseSchema)
  @Validate({ params: envelopeIdParams })
  async sendReminder(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.envelopes.sendManualReminder(u.orgId, envelopeId, actorFrom(u, req));
  }

  @Post(":envelopeId/extend-expiration")
  @RequirePermission("sign:envelope:correct")
  @ResponseSchema(envelopeMutationResponseSchema)
  @Validate({ params: envelopeIdParams, body: extendExpirationSchema })
  async extendExpiration(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: ExtendExpirationInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.envelopes.extendExpiration(u.orgId, envelopeId, body, actorFrom(u, req));
  }
}
