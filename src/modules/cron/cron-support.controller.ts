import {
  Controller,
  Get,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Post,
} from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { logger } from "../../common/logger/logger.service";
import { assertCronSecret } from "./cron-secret";
import { CronKbService } from "./cron-kb.service";
import { CronKbChunkRetentionService } from "./cron-kb-chunk-retention.service";
import { CronKbChatRetentionService } from "./cron-kb-chat-retention.service";
import { CronKbTelemetryRetentionService } from "./cron-kb-telemetry-retention.service";
import { CronSupportService } from "./cron-support.service";
import { SupportKbGapDetectionService } from "../support/kb-gap/support-kb-gap-detection.service";
import { CronLeaseService } from "./cron-lease.service";
import { SessionsService } from "../sessions/sessions.service";
import {
  supportSlaEscalationsResponseSchema,
  supportUnsnoozeResponseSchema,
  kbTrashPurgeResponseSchema,
  kbChunkRetentionSweepResponseSchema,
  supportKbGapDetectResponseSchema,
  kbTelemetryRetentionSweepResponseSchema,
  kbChatHistoryPurgeResponseSchema,
  sessionRevocationPruneResponseSchema,
} from "./dto/cron-support-response.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronSupportController {
  constructor(
    private readonly kb: CronKbService,
    private readonly kbChunkRetention: CronKbChunkRetentionService,
    private readonly kbChatRetention: CronKbChatRetentionService,
    private readonly kbTelemetryRetention: CronKbTelemetryRetentionService,
    private readonly support: CronSupportService,
    private readonly supportKbGap: SupportKbGapDetectionService,
    private readonly cronLease: CronLeaseService,
    private readonly sessions: SessionsService,
  ) {}

  @Get("support-sla-escalations")
  @ResponseSchema(supportSlaEscalationsResponseSchema)
  getSupportSlaEscalations(@Headers("authorization") authorization?: string) {
    return this.runSupportSlaEscalations(authorization);
  }

  @Post("support-sla-escalations")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(supportSlaEscalationsResponseSchema)
  postSupportSlaEscalations(@Headers("authorization") authorization?: string) {
    return this.runSupportSlaEscalations(authorization);
  }

  @Get("support-unsnooze")
  @ResponseSchema(supportUnsnoozeResponseSchema)
  getSupportUnsnooze(@Headers("authorization") authorization?: string) {
    return this.runSupportUnsnooze(authorization);
  }

  @Post("support-unsnooze")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(supportUnsnoozeResponseSchema)
  postSupportUnsnooze(@Headers("authorization") authorization?: string) {
    return this.runSupportUnsnooze(authorization);
  }

  @Get("kb-trash-purge")
  @ResponseSchema(kbTrashPurgeResponseSchema)
  getKbTrashPurge(@Headers("authorization") authorization?: string) {
    return this.runKbTrashPurge(authorization);
  }

  @Post("kb-trash-purge")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(kbTrashPurgeResponseSchema)
  postKbTrashPurge(@Headers("authorization") authorization?: string) {
    return this.runKbTrashPurge(authorization);
  }

  @Get("kb-chunk-retention-sweep")
  @ResponseSchema(kbChunkRetentionSweepResponseSchema)
  getKbChunkRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runKbChunkRetentionSweep(authorization);
  }

  @Post("kb-chunk-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(kbChunkRetentionSweepResponseSchema)
  postKbChunkRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runKbChunkRetentionSweep(authorization);
  }

  @Get("support-kb-gap-detect")
  @ResponseSchema(supportKbGapDetectResponseSchema)
  getSupportKbGapDetect(@Headers("authorization") authorization?: string) {
    return this.runSupportKbGapDetect(authorization);
  }

  @Post("support-kb-gap-detect")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(supportKbGapDetectResponseSchema)
  postSupportKbGapDetect(@Headers("authorization") authorization?: string) {
    return this.runSupportKbGapDetect(authorization);
  }

  @Get("kb-telemetry-retention-sweep")
  @ResponseSchema(kbTelemetryRetentionSweepResponseSchema)
  getKbTelemetryRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runKbTelemetryRetentionSweep(authorization);
  }

  @Post("kb-telemetry-retention-sweep")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(kbTelemetryRetentionSweepResponseSchema)
  postKbTelemetryRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runKbTelemetryRetentionSweep(authorization);
  }

  @Get("kb-chat-history-purge")
  @ResponseSchema(kbChatHistoryPurgeResponseSchema)
  getKbChatHistoryPurge(@Headers("authorization") authorization?: string) {
    return this.runKbChatHistoryPurge(authorization);
  }

  @Post("kb-chat-history-purge")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(kbChatHistoryPurgeResponseSchema)
  postKbChatHistoryPurge(@Headers("authorization") authorization?: string) {
    return this.runKbChatHistoryPurge(authorization);
  }

  @Get("session-revocation-prune")
  @ResponseSchema(sessionRevocationPruneResponseSchema)
  getSessionRevocationPrune(@Headers("authorization") authorization?: string) {
    return this.runSessionRevocationPrune(authorization);
  }

  @Post("session-revocation-prune")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(sessionRevocationPruneResponseSchema)
  postSessionRevocationPrune(@Headers("authorization") authorization?: string) {
    return this.runSessionRevocationPrune(authorization);
  }

  private async runSupportSlaEscalations(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("support-sla-escalations", 300, () =>
        this.support.runSlaEscalations(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "support-sla-escalations already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Checked ${result.checked} tickets across ${result.orgsProcessed} orgs, escalated ${result.escalated}`,
        ...result,
      };
    } catch (error) {
      logger.error("Support SLA escalation cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runSupportUnsnooze(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("support-unsnooze", 120, () =>
        this.support.runUnsnooze(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "support-unsnooze already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Unsnoozed ${result.unsnoozed} tickets`,
        ...result,
      };
    } catch (error) {
      logger.error("Support unsnooze cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runKbTrashPurge(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("kb-trash-purge", 300, () =>
        this.kb.purgeExpiredTrash(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "kb-trash-purge already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Purged ${result.purgedCount} KB pages across ${result.orgsProcessed} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("KB trash purge cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runKbChunkRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("kb-chunk-retention-sweep", 600, () =>
        this.kbChunkRetention.pruneStaleChunks(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "kb-chunk-retention-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `KB chunk retention: pruned ${result.articleChunksPruned} article chunks, ${result.pageChunksPruned} page chunks across ${result.orgsProcessed} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("KB chunk retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runSupportKbGapDetect(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("support-kb-gap-detect", 600, () =>
        this.supportKbGap.runDetectAllOrgs(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "support-kb-gap-detect already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `Support KB gap detect: processed ${result.processed} orgs, ${result.errors} errors`,
        ...result,
      };
    } catch (error) {
      logger.error("Support KB gap detect cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
  private async runKbTelemetryRetentionSweep(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("kb-telemetry-retention-sweep", 600, () =>
        this.kbTelemetryRetention.sweep(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "kb-telemetry-retention-sweep already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `KB telemetry retention: deleted ${result.eventsDeleted} events and ${result.checkpointsDeleted} ingestion checkpoints across ${result.orgsProcessed} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("KB telemetry retention sweep cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runKbChatHistoryPurge(authorization?: string) {
    assertCronSecret(authorization);
    if (process.env.KB_CHAT_PURGE_WORKER_ENABLED === "false")
      return { success: true, skipped: true, message: "KB chat history purge disabled" };
    try {
      const outcome = await this.cronLease.withLease("kb-chat-history-purge", 600, () =>
        this.kbChatRetention.purgeExpiredConversations(),
      );
      if (!outcome.ran) return { success: true, skipped: true, message: "kb-chat-history-purge already running" };
      const result = outcome.result;
      return {
        success: true,
        message: `KB chat history purge: deleted ${result.conversationsDeleted} conversations across ${result.orgsProcessed} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("KB chat history purge cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }

  private async runSessionRevocationPrune(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("session-revocation-prune", 120, () =>
        this.sessions.pruneExpiredRevocations(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "session-revocation-prune already running" };
      return {
        success: true,
        message: `Pruned ${outcome.result.removed} expired session tombstones`,
        ...outcome.result,
      };
    } catch (error) {
      logger.error("Session revocation prune cron failed", error);
      throw new InternalServerErrorException("Internal server error");
    }
  }
}
