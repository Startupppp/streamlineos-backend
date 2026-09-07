import { Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from "@nestjs/common";
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
import { SignAuditService } from "./sign-audit.service";
import { SignFinalizationService } from "./sign-finalization.service";
import { resolveEnvelopeViewScope } from "./sign-envelope-scope";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  listAuditEventsResponseSchema,
  getCertificateUrlResponseSchema,
  getFinalPdfUrlResponseSchema,
  regenerateCertificateResponseSchema,
} from "./dto/e-sign-response.schemas";
import { resolveClientIp } from "../../common/http/client-ip";


const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign/envelopes")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignCertificatesController {
  constructor(
    private readonly audit: SignAuditService,
    private readonly finalization: SignFinalizationService,
    private readonly access: AccessService,
  ) {}

  @Get(":envelopeId/audit")
  @RequirePermission("sign:audit:view")
  @ResponseSchema(listAuditEventsResponseSchema)
  @Validate({ params: envelopeIdParams })
  async getAudit(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.audit.listForEnvelope(u.orgId, envelopeId, scope);
  }

  @Get(":envelopeId/certificate")
  @RequirePermission("sign:certificate:download")
  @ResponseSchema(getCertificateUrlResponseSchema)
  @Validate({ params: envelopeIdParams })
  async getCertificate(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.finalization.getCertificateUrl(u.orgId, envelopeId, scope);
  }

  @Get(":envelopeId/final-pdf")
  @RequirePermission("sign:certificate:download")
  @ResponseSchema(getFinalPdfUrlResponseSchema)
  @Validate({ params: envelopeIdParams })
  async getFinalPdf(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    const scope = await resolveEnvelopeViewScope(this.access, u);
    return this.finalization.getFinalPdfUrl(u.orgId, envelopeId, { userId: u.userId, ipAddress: resolveClientIp(req) }, scope);
  }

  @Post(":envelopeId/regenerate-certificate")
  @BodylessAction()
  @RequirePermission("sign:admin:manage")
  @ResponseSchema(regenerateCertificateResponseSchema)
  @Validate({ params: envelopeIdParams })
  regenerateCertificate(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.finalization.regenerateCertificate(u.orgId, envelopeId, { userId: u.userId, ipAddress: resolveClientIp(req) });
  }
}
