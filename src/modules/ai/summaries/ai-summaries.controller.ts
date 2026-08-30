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
import { NoTenantTransaction } from "../../../common/tenant/no-tenant-transaction.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AiSummariesService } from "./ai-summaries.service";
import { saveSnapshotSchema, isAllowedEntityType, type SaveSnapshotInput } from "./save-snapshot.dto";
import type { SnapshotWithDiff } from "./ai-summaries.types";
import type { AiSummarySnapshot } from "../../../db/schema/ai/ai-summaries";

@Controller("ai/summaries")
@UseGuards(JwtAuthGuard, PermissionGuard)
@NoTenantTransaction()
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
    @Body(new ZodValidationPipe(saveSnapshotSchema)) body: SaveSnapshotInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<AiSummarySnapshot> {
    if (!isAllowedEntityType(entityType)) {
      throw new BadRequestException(`Invalid entityType: ${entityType}`);
    }
    return this.aiSummaries.saveSnapshot(u.orgId, entityType, entityId, body, u.userId);
  }
}
