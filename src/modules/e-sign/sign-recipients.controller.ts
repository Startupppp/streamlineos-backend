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
import { actingMembershipId } from "../../common/auth/principal";
import { Validate } from "../../common/validation/validate.decorator";
import { AccessService } from "../access/access.service";
import { SignRecipientsService } from "./sign-recipients.service";
import { SignEnvelopeAccessService } from "./sign-envelope-access.service";
import { resolveEnvelopeViewScope } from "./sign-envelope-scope";
import {
  createRecipientSchema,
  updateRecipientSchema,
  type CreateRecipientInput,
  type UpdateRecipientInput,
} from "./dto/e-sign.schemas";
import { resolveClientIp } from "../../common/http/client-ip";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  recipientMutationResponseSchema,
  listRecipientsResponseSchema,
} from "./dto/e-sign-response.schemas";
import { successSchema } from "../../common/openapi/response-envelopes";


const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();
const recipientIdParams = z.object({ recipientId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignRecipientsController {
  constructor(
    private readonly recipients: SignRecipientsService,
    private readonly access: AccessService,
    private readonly envelopeAccess: SignEnvelopeAccessService,
  ) {}

  @Post("envelopes/:envelopeId/recipients")
  @HttpCode(201)
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(recipientMutationResponseSchema)
  @Validate({ params: envelopeIdParams, body: createRecipientSchema })
  async add(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: CreateRecipientInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.recipients.add(u.orgId, envelopeId, body, { orgId: u.orgId, userId: u.userId, ipAddress: resolveClientIp(req) });
  }

  @Get("envelopes/:envelopeId/recipients")
  @RequirePermission("sign:envelope:view")
  @ResponseSchema(listRecipientsResponseSchema)
  @Validate({ params: envelopeIdParams })
  async list(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.recipients.listForEnvelope(scope, actingMembershipId(u.principal), envelopeId);
  }

  @Patch("recipients/:recipientId")
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(recipientMutationResponseSchema)
  @Validate({ params: recipientIdParams, body: updateRecipientSchema })
  async update(
    @Param("recipientId", ParseIntPipe) recipientId: number,
    @Body() body: UpdateRecipientInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    await this.envelopeAccess.mustGetActionableByRecipient(u, recipientId);
    return this.recipients.update(u.orgId, recipientId, body, { orgId: u.orgId, userId: u.userId, ipAddress: resolveClientIp(req) });
  }

  @Delete("recipients/:recipientId")
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(successSchema)
  @Validate({ params: recipientIdParams })
  async remove(@Param("recipientId", ParseIntPipe) recipientId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    await this.envelopeAccess.mustGetActionableByRecipient(u, recipientId);
    await this.recipients.remove(u.orgId, recipientId, { orgId: u.orgId, userId: u.userId, ipAddress: resolveClientIp(req) });
    return { success: true };
  }
}
