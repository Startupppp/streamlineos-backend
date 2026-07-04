import {
  Controller,
  Get,
  Query,
  UseGuards,
  ForbiddenException,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { JournalService } from "./journal.service";
import { buildCsv } from "./lib/csv";

const CSV_HEADERS = ["account", "description", "debit", "credit", "costCenter"] as const;

@Controller("payroll/reports/journal")
export class JournalController {
  constructor(private readonly journalService: JournalService) {}

  @Get()
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission("payroll:reports:view")
  async getJournal(
    @Query("month") month: string | undefined,
    @Query("format") format: string | undefined,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const targetMonth = month ?? new Date().toISOString().slice(0, 7);
    const result = await this.journalService.buildJournal(u.orgId, targetMonth);

    if (format === "csv") {
      if (!u.permissions.includes("payroll:reports:export")) {
        throw new ForbiddenException();
      }

      const rows = result.lines.map((line) => [
        line.account,
        line.description,
        line.debit,
        line.credit,
        line.costCenter,
      ]);

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="journal-${targetMonth}.csv"`,
      );

      return buildCsv([...CSV_HEADERS], rows);
    }

    return result;
  }
}
