import {
  Body,
  Controller,
  ForbiddenException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermission } from "../access/require-permission.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { Validate } from "../../common/validation/validate.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { GdprService } from "./gdpr.service";
import { exportRequestBodySchema, type ExportRequestBody } from "./dto/gdpr.schemas";

@Controller("gdpr")
export class GdprController {
  constructor(private readonly gdpr: GdprService) {}

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
    await this.gdpr.recordExportRequest(user.orgId, user.userId, user.userId, body.reason);
    return result;
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
    await this.gdpr.recordExportRequest(user.orgId, personId, user.userId, body.reason);
    return result;
  }
}
