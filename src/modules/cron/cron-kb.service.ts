import { Inject, Injectable } from "@nestjs/common";
import { KbPageTrashService } from "../kb/wiki/kb-page-trash.service";
import { KbSettingsService } from "../kb/core/kb-settings.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";

@Injectable()
export class CronKbService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly trash: KbPageTrashService,
    private readonly settings: KbSettingsService,
  ) {}

  async purgeExpiredTrash(): Promise<{ orgsProcessed: number; purgedCount: number }> {
    let purgedCount = 0;

    const result = await forEachOrg(this.db, "kb-trash-purge", async (_tx, orgId) => {
      const { trashRetentionDays } = await this.settings.getOrgSettings(orgId);
      const olderThan = new Date(Date.now() - trashRetentionDays * 86_400_000);
      const count = await this.trash.purgeExpired(orgId, olderThan);
      purgedCount += count;
    });

    return { orgsProcessed: result.succeeded, purgedCount };
  }
}
