import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ClientPortalManagementService } from "./client-portal-management.service";
import { ClientPortalService } from "./client-portal.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../../common/openapi/zod-operation-contracts";
import { z } from "zod";
import {
  portalSettingsSchema,
  portalPreviewSchema,
} from "./dto/client-portal-management-response.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build/:projectId/client-portal")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ClientPortalManagementController {
  constructor(
    private readonly mgmt: ClientPortalManagementService,
    private readonly portal: ClientPortalService,
  ) {}

  @Get("settings")
  @RequirePermission("build:clientvisibility:manage")
  @ResponseSchema(portalSettingsSchema)
  @Validate({ params: projectIdParams })
  getSettings(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mgmt.getSettings(u, projectId);
  }

  @Post("publish")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("build:clientvisibility:manage")
  @ResponseSchema(portalSettingsSchema)
  @Validate({ params: projectIdParams })
  publishPortal(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mgmt.publishPortal(u, projectId);
  }

  @Post("unpublish")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("build:clientvisibility:manage")
  @ResponseSchema(portalSettingsSchema)
  @Validate({ params: projectIdParams })
  unpublishPortal(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.mgmt.unpublishPortal(u, projectId);
  }

  @Get("preview")
  @RequirePermission("build:clientvisibility:manage")
  @ResponseSchema(portalPreviewSchema)
  @Validate({ params: projectIdParams })
  getPreview(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.portal.getPortalPreview(u, projectId);
  }
}
