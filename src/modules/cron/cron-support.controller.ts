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
import { CronSupportService } from "./cron-support.service";
import { SupportKbGapService } from "../support/kb-gap/support-kb-gap.service";
import { CronLeaseService } from "./cron-lease.service";

@Public()
@Controller("cron")
export class CronSupportController {
  constructor(
    private readonly kb: CronKbService,
    private readonly kbChunkRetention: CronKbChunkRetentionService,
    private readonly support: CronSupportService,
    private readonly supportKbGap: SupportKbGapService,
    private readonly cronLease: CronLeaseService,
  ) {}

  @Get("support-sla-escalations")
  getSupportSlaEscalations(@Headers("authorization") authorization?: string) {
    return this.runSupportSlaEscalations(authorization);
  }

  @Post("support-sla-escalations")
  @HttpCode(200)
  postSupportSlaEscalations(@Headers("authorization") authorization?: string) {
    return this.runSupportSlaEscalations(authorization);
  }

  @Get("support-unsnooze")
  getSupportUnsnooze(@Headers("authorization") authorization?: string) {
    return this.runSupportUnsnooze(authorization);
  }

  @Post("support-unsnooze")
  @HttpCode(200)
  postSupportUnsnooze(@Headers("authorization") authorization?: string) {
    return this.runSupportUnsnooze(authorization);
  }

  @Get("kb-trash-purge")
  getKbTrashPurge(@Headers("authorization") authorization?: string) {
    return this.runKbTrashPurge(authorization);
  }

  @Post("kb-trash-purge")
  @HttpCode(200)
  postKbTrashPurge(@Headers("authorization") authorization?: string) {
    return this.runKbTrashPurge(authorization);
  }

  @Get("kb-chunk-retention-sweep")
  getKbChunkRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runKbChunkRetentionSweep(authorization);
  }

  @Post("kb-chunk-retention-sweep")
  @HttpCode(200)
  postKbChunkRetentionSweep(@Headers("authorization") authorization?: string) {
    return this.runKbChunkRetentionSweep(authorization);
  }

  @Get("support-kb-gap-detect")
  getSupportKbGapDetect(@Headers("authorization") authorization?: string) {
    return this.runSupportKbGapDetect(authorization);
  }

  @Post("support-kb-gap-detect")
  @HttpCode(200)
  postSupportKbGapDetect(@Headers("authorization") authorization?: string) {
    return this.runSupportKbGapDetect(authorization);
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
}
