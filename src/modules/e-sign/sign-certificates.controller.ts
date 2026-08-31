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
import { SignAuditService } from "./sign-audit.service";
import { SignFinalizationService } from "./sign-finalization.service";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(",")[0]?.trim() || req.ip)?.slice(0, 100);
}

const envelopeIdParams = z.object({ envelopeId: z.coerce.number().int().positive() }).strict();

@RequireModule("sign")
@Controller("sign/envelopes")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignCertificatesController {
  constructor(
    private readonly audit: SignAuditService,
    private readonly finalization: SignFinalizationService,
  ) {}

  @Get(":envelopeId/audit")
  @RequirePermission("sign:audit:view")
  @Validate({ params: envelopeIdParams })
  getAudit(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    return this.audit.listForEnvelope(u.orgId, envelopeId);
  }

  @Get(":envelopeId/certificate")
  @RequirePermission("sign:certificate:download")
  @Validate({ params: envelopeIdParams })
  getCertificate(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext) {
    return this.finalization.getCertificateUrl(u.orgId, envelopeId);
  }

  @Get(":envelopeId/final-pdf")
  @RequirePermission("sign:certificate:download")
  @Validate({ params: envelopeIdParams })
  getFinalPdf(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.finalization.getFinalPdfUrl(u.orgId, envelopeId, { userId: u.userId, ipAddress: clientIp(req) });
  }

  @Post(":envelopeId/regenerate-certificate")
  @BodylessAction()
  @RequirePermission("sign:admin:manage")
  @Validate({ params: envelopeIdParams })
  regenerateCertificate(@Param("envelopeId", ParseIntPipe) envelopeId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.finalization.regenerateCertificate(u.orgId, envelopeId, { userId: u.userId, ipAddress: clientIp(req) });
  }
}
