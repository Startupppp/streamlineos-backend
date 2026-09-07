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
import { z } from "zod";
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
import {
  gdprAsyncExportBodySchema,
  gdprExportJobIdParams,
  type GdprAsyncExportBody,
} from "./dto/gdpr-async-export.schemas";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import {
  gdprRectificationBodySchema,
  type GdprRectificationBody,
} from "./dto/gdpr-rectification.schemas";
import { GdprRectificationService } from "./gdpr-rectification.service";
import { gdprErasureBodySchema, type GdprErasureBody } from "./dto/gdpr-erasure.schemas";
import { GdprSubjectErasureService } from "./gdpr-subject-erasure.service";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  exportResultSchema,
  rectifyProfileSchema,
  exportJobSchema,
  erasureResultSchema,
} from "./dto/gdpr-response.schemas";


/**
 * PRD-C048 — three data-subject routes bound their path id with neither a pipe nor a
 * `@Validate({ params })`, so an arbitrary segment reached the export/erasure services
 * unchecked. `gdprExportJobIdParams` in the same file already did this right; these
 * three are the sibling ids that were missed. `.min(1)` matches the repo-wide shape for
 * a `users.id` path segment, which is `text`, not a uuid.
 */
const personIdParams = z.object({ personId: z.string().min(1).max(128) }).strict();
const subjectIdParams = z.object({ subjectId: z.string().min(1).max(128) }).strict();

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
  @ResponseSchema(exportResultSchema)
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
  @ResponseSchema(rectifyProfileSchema)
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
  @ResponseSchema(exportResultSchema)
  @Validate({ params: personIdParams, body: exportRequestBodySchema })
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
  @ResponseSchema(exportJobSchema)
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
  @ResponseSchema(exportJobSchema)
  @Validate({ params: personIdParams, body: gdprAsyncExportBodySchema })
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
  @ResponseSchema(exportJobSchema)
  @Validate({ params: gdprExportJobIdParams })
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
  @Validate({ params: gdprExportJobIdParams })
  @Header("Content-Disposition", "attachment")
  @ApiOkResponse({ description: "GDPR export archive download", content: { "application/json": { schema: { type: "string", format: "binary" } } } })
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
  @ResponseSchema(erasureResultSchema)
  @Validate({ params: subjectIdParams, body: gdprErasureBodySchema })
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
