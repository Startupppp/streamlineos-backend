import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { Universal } from "../../../common/auth/universal.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { HrReportingLinesService } from "./reporting-lines.service";
import { myReportingLineSchema } from "./dto/reporting-lines-line.schemas";

@RequireModule("hr")
@Controller("me/reporting-line")
@UseGuards(JwtAuthGuard)
export class MyReportingLineController {
  constructor(private readonly lines: HrReportingLinesService) {}

  @Get()
  @Universal()
  @ResponseSchema(myReportingLineSchema)
  get(@CurrentUser() actor: CurrentUserContext) {
    return this.lines.myLine(actor);
  }
}
