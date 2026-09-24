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
import { CronLeaseService } from "./cron-lease.service";
import { KbStuckSourceReaperService } from "../kb/retrieval/kb-stuck-source-reaper.service";
import {
  kbTrashPurgeResponseSchema,
  kbChunkRetentionSweepResponseSchema,
  kbTelemetryRetentionSweepResponseSchema,
  kbChatHistoryPurgeResponseSchema,
  kbStuckSourceReapResponseSchema,
} from "./dto/cron-support-response.schemas";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";

@Public()
@Controller("cron")
export class CronKbController {
  constructor(
    private readonly kb: CronKbService,
    private readonly kbChunkRetention: CronKbChunkRetentionService,
    private readonly kbChatRetention: CronKbChatRetentionService,
    private readonly kbTelemetryRetention: CronKbTelemetryRetentionService,
    private readonly kbStuckSources: KbStuckSourceReaperService,
    private readonly cronLease: CronLeaseService,
  ) {}

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

  @Get("kb-stuck-source-reap")
  @ResponseSchema(kbStuckSourceReapResponseSchema)
  getKbStuckSourceReap(@Headers("authorization") authorization?: string) {
    return this.runKbStuckSourceReap(authorization);
  }

  @Post("kb-stuck-source-reap")
  @BodylessAction()
  @HttpCode(200)
  @ResponseSchema(kbStuckSourceReapResponseSchema)
  postKbStuckSourceReap(@Headers("authorization") authorization?: string) {
    return this.runKbStuckSourceReap(authorization);
  }

  private async runKbStuckSourceReap(authorization?: string) {
    assertCronSecret(authorization);
    try {
      const outcome = await this.cronLease.withLease("kb-stuck-source-reap", 600, () =>
        this.kbStuckSources.reap(),
      );
      if (!outcome.ran)
        return { success: true, skipped: true, message: "kb-stuck-source-reap already running" };
      const result = outcome.result;
      return {
        success: true,
        message:
          `KB stuck sources: failed ${result.sourcesFailed} source(s) across ${result.orgsProcessed} orgs` +
          (result.truncated ? " (truncated — rerun)" : ""),
        ...result,
      };
    } catch (error) {
      logger.error("KB stuck source reap cron failed", error);
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
        message: `Purged ${result.purgedCount} KB pages and ${result.linkedDocumentsPurged} HR-document entries across ${result.orgsProcessed} orgs`,
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
        message: `KB chunk retention: pruned ${result.pageChunksPruned} page chunks across ${result.orgsProcessed} orgs`,
        ...result,
      };
    } catch (error) {
      logger.error("KB chunk retention sweep cron failed", error);
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
}
