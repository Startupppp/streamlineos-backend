import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { IdempotencyKey } from "../../../common/idempotency/idempotency-key.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { TicketImportService } from "./ticket-import.service";
import { TicketExportService } from "./ticket-export.service";
import {
  commitTicketImportSchema,
  exportTicketsQuerySchema,
  importExportProjectParams,
  previewTicketImportSchema,
  type CommitTicketImportInput,
  type ExportTicketsQuery,
  type PreviewTicketImportInput,
} from "./dto/import-export-request.schemas";
import {
  importPreviewSchema,
  importReportSchema,
  ticketExportSchema,
} from "./dto/import-export-response.schemas";

@RequireModule("build")
@Controller("build/:projectId/import-export")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TicketImportExportController {
  constructor(
    private readonly imports: TicketImportService,
    private readonly exports: TicketExportService,
  ) {}

  @Post("tickets/preview")
  @HttpCode(200)
  @RequirePermission("build:tickets:create")
  @ResponseSchema(importPreviewSchema)
  @Validate({ params: importExportProjectParams, body: previewTicketImportSchema })
  previewImport(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: PreviewTicketImportInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.imports.previewImport(u, projectId, body);
  }

  @Post("tickets")
  @HttpCode(200)
  @RequirePermission("build:tickets:create")
  @ResponseSchema(importReportSchema)
  @Validate({ params: importExportProjectParams, body: commitTicketImportSchema })
  commitImport(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CommitTicketImportInput,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.imports.commitImport(u, projectId, { ...body, idempotencyKey });
  }

  @Get("tickets/export")
  @RequirePermission("build:tickets:view")
  @ResponseSchema(ticketExportSchema)
  @Validate({ params: importExportProjectParams, query: exportTicketsQuerySchema })
  exportTickets(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ExportTicketsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exports.exportTickets(u, projectId, query);
  }
}
