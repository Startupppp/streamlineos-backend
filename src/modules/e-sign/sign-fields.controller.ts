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
import { AccessService } from "../access/access.service";
import { SignFieldsService } from "./sign-fields.service";
import { resolveEnvelopeViewScope } from "./sign-envelope-scope";
import { createFieldSchema, updateFieldSchema, type CreateFieldInput, type UpdateFieldInput } from "./dto/e-sign.schemas";
import { resolveClientIp } from "../../common/http/client-ip";


const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();
const fieldIdParams = z.object({ fieldId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignFieldsController {
  constructor(
    private readonly fields: SignFieldsService,
    private readonly access: AccessService,
  ) {}

  @Post("envelopes/:envelopeId/fields")
  @HttpCode(201)
  @RequirePermission("sign:envelope:create")
  @Validate({ params: envelopeIdParams, body: createFieldSchema })
  add(
    @Param("envelopeId", ParseIntPipe) envelopeId: number,
    @Body() body: CreateFieldInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.fields.add(u.orgId, envelopeId, body, { orgId: u.orgId, userId: u.userId, ipAddress: resolveClientIp(req) });
  }

  @Get("envelopes/:envelopeId/fields")
  @RequirePermission("sign:envelope:view")
  @Validate({ params: envelopeIdParams })
  async list(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.fields.listForEnvelope(u.orgId, envelopeId, scope);
  }

  @Patch("fields/:fieldId")
  @RequirePermission("sign:envelope:create")
  @Validate({ params: fieldIdParams, body: updateFieldSchema })
  update(
    @Param("fieldId", ParseIntPipe) fieldId: number,
    @Body() body: UpdateFieldInput,
    @CurrentUser() u: CurrentUserContext,
    @Req() req: Request,
  ) {
    return this.fields.update(u.orgId, fieldId, body, { orgId: u.orgId, userId: u.userId, ipAddress: resolveClientIp(req) });
  }

  @Delete("fields/:fieldId")
  @RequirePermission("sign:envelope:create")
  @Validate({ params: fieldIdParams })
  async remove(@Param("fieldId", ParseIntPipe) fieldId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    await this.fields.remove(u.orgId, fieldId, { orgId: u.orgId, userId: u.userId, ipAddress: resolveClientIp(req) });
    return { success: true };
  }
}
