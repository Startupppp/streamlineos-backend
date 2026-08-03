import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AiSummariesService } from "./ai-summaries.service";
import { saveSnapshotSchema, isAllowedEntityType } from "./save-snapshot.dto";
import type { SnapshotWithDiff } from "./ai-summaries.types";
import type { AiSummarySnapshot } from "../../../db/schema/ai/ai-summaries";

@Controller("ai/summaries")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AiSummariesController {
  constructor(private readonly aiSummaries: AiSummariesService) {}

  @Get(":entityType/:entityId")
  @RequirePermission("ai:summaries:view")
  async getLatest(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<SnapshotWithDiff | null> {
    if (!isAllowedEntityType(entityType)) {
      throw new BadRequestException(`Invalid entityType: ${entityType}`);
    }
    return this.aiSummaries.getLatestWithDiff(u.orgId, entityType, entityId);
  }

  @Post(":entityType/:entityId/snapshot")
  @HttpCode(201)
  @RequirePermission("ai:summaries:create")
  async saveSnapshot(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<AiSummarySnapshot> {
    if (!isAllowedEntityType(entityType)) {
      throw new BadRequestException(`Invalid entityType: ${entityType}`);
    }
    const parsed = saveSnapshotSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    return this.aiSummaries.saveSnapshot(u.orgId, entityType, entityId, parsed.data, u.userId);
  }
}
