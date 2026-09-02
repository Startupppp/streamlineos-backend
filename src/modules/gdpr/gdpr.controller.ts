import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermission } from "../access/require-permission.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { Validate } from "../../common/validation/validate.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { authorize } from "../access/authorize";
import { GdprService } from "./gdpr.service";
import { GdprExportService } from "./gdpr-export.service";
import { exportRequestBodySchema, type ExportRequestBody } from "./dto/gdpr.schemas";
import { gdprAsyncExportBodySchema, type GdprAsyncExportBody } from "./dto/gdpr-async-export.schemas";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import {
  gdprRectificationBodySchema,
  type GdprRectificationBody,
} from "./dto/gdpr-rectification.schemas";
import { GdprRectificationService } from "./gdpr-rectification.service";
import { gdprErasureBodySchema, type GdprErasureBody } from "./dto/gdpr-erasure.schemas";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";

@Controller("gdpr")
export class GdprController {
  constructor(
    private readonly gdpr: GdprService,
    private readonly gdprExport: GdprExportService,
    private readonly gdprRectification: GdprRectificationService,
    private readonly gdprErasure: GdprSubjectErasureService,
    private readonly access: AccessService,
  ) {}

  @AuthorizedInService(
    "JWT sub is the subject — caller exports only their own data; identity derived from the token, never accepted from the client",
  )
  @Post("export/me")
  @Validate({ body: exportRequestBodySchema })
  async exportOwnData(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: ExportRequestBody,
  ) {
    if (!user.orgId) throw new ForbiddenException("An active organization is required");
    const result = await this.gdpr.exportSubjectData(
      user.userId,
      user.userId,
      user.orgId,
      "all",
    );
    await this.gdpr.recordExportRequest(user.orgId, user.userId, user.userId, body.reason, result.exportIncomplete);
    return result;
  }

  @AuthorizedInService(
    "JWT sub is the subject — rectification is limited to the caller's own profile name",
  )
  @Post("rectification/me")
  @Idempotent("gdpr.rectification.profile-name")
  @Validate({ body: gdprRectificationBodySchema })
  async rectifyOwnProfile(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: GdprRectificationBody,
    @Req() req: Request,
  ) {
    if (!user.orgId) throw new ForbiddenException("An active organization is required");
    return this.gdprRectification.rectifyOwnProfile(user.orgId, user.userId, body, req.ip);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("hr:retention:manage")
  @Post("export/:personId")
  @Validate({ body: exportRequestBodySchema })
  async exportPersonData(
    @Param("personId") personId: string,
    @CurrentUser() user: CurrentUserContext,
    @Body() body: ExportRequestBody,
    @Req() req: Request & { rbacScope?: DataScope },
  ) {
    if (!user.orgId) throw new ForbiddenException("An active organization is required");
    const scope: DataScope = req.rbacScope ?? "none";
    const result = await this.gdpr.exportSubjectData(personId, user.userId, user.orgId, scope);
    await this.gdpr.recordExportRequest(user.orgId, personId, user.userId, body.reason, result.exportIncomplete);
    return result;
  }

  @AuthorizedInService(
    "JWT sub is the subject — async export for caller's own data; idempotency-key required",
  )
  @Post("export-async/me")
  @Validate({ body: gdprAsyncExportBodySchema })
  async createOwnExportJob(
    @CurrentUser() user: CurrentUserContext,
    @Body() body: GdprAsyncExportBody,
  ) {
    if (!user.orgId) throw new ForbiddenException("An active organization is required");
    return this.gdprExport.create(user.userId, user.orgId, user.userId, body.idempotencyKey);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("hr:retention:manage")
  @Post("export-async/:personId")
  @Validate({ body: gdprAsyncExportBodySchema })
  async createPersonExportJob(
    @Param("personId") personId: string,
    @CurrentUser() user: CurrentUserContext,
    @Body() body: GdprAsyncExportBody,
    @Req() req: Request & { rbacScope?: DataScope },
  ) {
    if (!user.orgId) throw new ForbiddenException("An active organization is required");
    const scope: DataScope = req.rbacScope ?? "none";
    if (scope === "none") throw new ForbiddenException("Export scope denies access");
    if (personId !== user.userId && scope !== "all")
      throw new ForbiddenException("Exporting another person's data requires organisation-wide scope");
    return this.gdprExport.create(user.userId, user.orgId, personId, body.idempotencyKey);
  }

  @AuthorizedInService(
    "caller must own the job (requestedBy = JWT sub) or hold hr:retention:manage; cross-org jobId returns 404",
  )
  @UseGuards(JwtAuthGuard)
  @Get("export-async/:jobId/status")
  async getExportJobStatus(
    @Param("jobId") jobId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    if (!user.orgId) throw new ForbiddenException("An active organization is required");
    const authResult = await authorize(this.access, user, "hr:retention:manage");
    const isAdmin = authResult.allow && authResult.scope === "all";
    return this.gdprExport.get(user.userId, user.orgId, jobId, isAdmin);
  }

  @AuthorizedInService(
    "caller must own the job or hold hr:retention:manage; cross-org jobId returns 404 to avoid confirming existence",
  )
  @UseGuards(JwtAuthGuard)
  @Get("export-async/:jobId/download")
  @Header("Content-Disposition", "attachment")
  async downloadExportJob(
    @Param("jobId") jobId: string,
    @CurrentUser() user: CurrentUserContext,
    @Res() res: Response,
  ) {
    if (!user.orgId) throw new ForbiddenException("An active organization is required");
    const authResult = await authorize(this.access, user, "hr:retention:manage");
    const isAdmin = authResult.allow && authResult.scope === "all";
    const { job, file } = await this.gdprExport.download(user.userId, user.orgId, jobId, isAdmin);
    if (!job.fileName) throw new BadRequestException("File name missing");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${job.fileName.replace(/"/g, "")}"`,
    );
    res.setHeader("Content-Type", "application/json");
    if (file.contentLength !== undefined)
      res.setHeader("Content-Length", String(file.contentLength));
    file.body.pipe(res);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission("hr:retention:manage")
  @Post("erasure/:subjectId")
  @Validate({ body: gdprErasureBodySchema })
  async eraseSubjectData(
    @Param("subjectId") subjectId: string,
    @CurrentUser() user: CurrentUserContext,
    @Body() body: GdprErasureBody,
  ) {
    if (!user.orgId) throw new ForbiddenException("An active organization is required");
    return this.gdprErasure.eraseSubject(subjectId, user.orgId, user.userId, {
      dryRun: body.dryRun ?? false,
    });
  }
}
