import {
  Controller,
  Get,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ReportsService } from "./reports.service";

@Controller("reports")
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("source-effectiveness")
  sourceEffectiveness(@CurrentUser() u: CurrentUserContext) {
    return this.reports.getSourceEffectiveness(u.orgId);
  }
}
