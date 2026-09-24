import { Controller, Get, Param, Res, UseGuards } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ApDocumentPdfService } from "./ap-document-pdf.service";

@RequireModule("accounting")
@Controller("accounting/payables/documents")
@UseGuards(JwtAuthGuard, ModuleGuard)
export class ApDocumentPdfController {
  constructor(private readonly pdfService: ApDocumentPdfService) {}

  @Get(":apDocumentId/pdf")
  @UseGuards(PermissionGuard)
  @RequirePermission("accounting:payables:read")
  @ApiOkResponse({ description: "PDF document bytes", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } })
  async render(
    @Param("apDocumentId") apDocumentId: string,
    @CurrentUser() user: CurrentUserContext,
    @Res() res: Response,
  ) {
    const pdf = await this.pdfService.render(user.orgId, apDocumentId);

    res.setHeader("Content-Type", pdf.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${pdf.fileName}"`);
    res.send(pdf.buffer);
  }
}
