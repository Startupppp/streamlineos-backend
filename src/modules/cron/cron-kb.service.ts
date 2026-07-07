import { Injectable, Logger } from "@nestjs/common";
import { KbPageTreeService } from "../kb/kb-page-tree.service";
import { KbSettingsService } from "../kb/kb-settings.service";

@Injectable()
export class CronKbService {
  private readonly logger = new Logger(CronKbService.name);

  constructor(
    private readonly tree: KbPageTreeService,
    private readonly settings: KbSettingsService,
  ) {}

  async purgeExpiredTrash(): Promise<{ orgsProcessed: number; purgedCount: number }> {
    const orgRetentions = await this.settings.getOrgsWithTrashedPages();

    let purgedCount = 0;
    for (const { orgId, trashRetentionDays } of orgRetentions) {
      const olderThan = new Date(Date.now() - trashRetentionDays * 86_400_000);
      try {
        const count = await this.tree.purgeExpired(orgId, olderThan);
        purgedCount += count;
      } catch (err: unknown) {
        this.logger.error(`KB trash purge failed for org ${orgId}: ${err}`);
      }
    }

    return { orgsProcessed: orgRetentions.length, purgedCount };
  }
}
