import { Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { SignAuditService } from "./sign-audit.service";
import { SignFinalizationService } from "./sign-finalization.service";

function clientIp(req: Request): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(",")[0]?.trim() || req.ip)?.slice(0, 100);
}

@RequireModule("sign")
@Controller("sign/envelopes")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SignCertificatesController {
  constructor(
    private readonly audit: SignAuditService,
    private readonly finalization: SignFinalizationService,
  ) {}

  @Get(":id/audit")
  @RequirePermission("sign:audit:view")
  getAudit(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.audit.listForEnvelope(u.orgId, id);
  }

  @Get(":id/certificate")
  @RequirePermission("sign:certificate:download")
  getCertificate(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext) {
    return this.finalization.getCertificateUrl(u.orgId, id);
  }

  @Get(":id/final-pdf")
  @RequirePermission("sign:certificate:download")
  getFinalPdf(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.finalization.getFinalPdfUrl(u.orgId, id, { userId: u.userId, ipAddress: clientIp(req) });
  }

  @Post(":id/regenerate-certificate")
  @RequirePermission("sign:admin:manage")
  regenerateCertificate(@Param("id", ParseIntPipe) id: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.finalization.regenerateCertificate(u.orgId, id, { userId: u.userId, ipAddress: clientIp(req) });
  }
}
