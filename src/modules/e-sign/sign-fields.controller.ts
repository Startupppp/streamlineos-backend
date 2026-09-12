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
import { SignFieldsService } from "./sign-fields.service";
import { SignEnvelopeAccessService } from "./sign-envelope-access.service";
import { resolveEnvelopeViewScope } from "./sign-envelope-scope";
import { createFieldSchema, updateFieldSchema, type CreateFieldInput, type UpdateFieldInput } from "./dto/e-sign.schemas";
import { resolveClientIp } from "../../common/http/client-ip";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { fieldMutationResponseSchema, listFieldsResponseSchema } from "./dto/e-sign-response.schemas";
import { successSchema } from "../../common/openapi/response-envelopes";


const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();
const fieldIdParams = z.object({ fieldId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignFieldsController {
  constructor(
    private readonly fields: SignFieldsService,
    private readonly access: AccessService,
    private readonly envelopeAccess: SignEnvelopeAccessService,
  ) {}

  @Post("envelopes/:envelopeId/fields")
  @HttpCode(201)
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(fieldMutationResponseSchema)
  @Validate({ params: envelopeIdParams, body: createFieldSchema })
  async add(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: CreateFieldInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    await this.envelopeAccess.mustGetActionable(u, envelopeId);
    return this.fields.add(u.orgId, envelopeId, body, { orgId: u.orgId, userId: u.userId, ipAddress: resolveClientIp(req) });
  }

  @Get("envelopes/:envelopeId/fields")
  @RequirePermission("sign:envelope:view")
  @ResponseSchema(listFieldsResponseSchema)
  @Validate({ params: envelopeIdParams })
  async list(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.fields.listForEnvelope(scope, actingMembershipId(u.principal), envelopeId);
  }

  @Patch("fields/:fieldId")
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(fieldMutationResponseSchema)
  @Validate({ params: fieldIdParams, body: updateFieldSchema })
  async update(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body() body: UpdateFieldInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    await this.envelopeAccess.mustGetActionableByField(u, fieldId);
    return this.fields.update(u.orgId, fieldId, body, { orgId: u.orgId, userId: u.userId, ipAddress: resolveClientIp(req) });
  }

  @Delete("fields/:fieldId")
  @RequirePermission("sign:envelope:create")
  @ResponseSchema(successSchema)
  @Validate({ params: fieldIdParams })
  async remove(@Param("fieldId", ParseIntPipe) fieldId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    await this.envelopeAccess.mustGetActionableByField(u, fieldId);
    await this.fields.remove(u.orgId, fieldId, { orgId: u.orgId, userId: u.userId, ipAddress: resolveClientIp(req) });
    return { success: true };
  }
}
