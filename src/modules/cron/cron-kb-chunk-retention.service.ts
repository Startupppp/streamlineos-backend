import { Inject, Injectable, Logger } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { pruneStaleDocumentChunks } from "../kb/core/kb-chunk-retention";

export interface KbChunkRetentionResult {
  orgsProcessed: number;
  pageChunksPruned: number;
}

@Injectable()
export class CronKbChunkRetentionService {
  private readonly logger = new Logger(CronKbChunkRetentionService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async pruneStaleChunks(): Promise<KbChunkRetentionResult> {
    let pageChunksPruned = 0;

    const result = await forEachOrg(this.db, "kb-chunk-retention", async (tx, orgId) => {
      pageChunksPruned += await pruneStaleDocumentChunks(tx, orgId);
    });

    this.logger.log(
      `KB chunk retention: pruned ${pageChunksPruned} page chunks across ${result.succeeded} orgs`,
    );

    return { orgsProcessed: result.succeeded, pageChunksPruned };
  }
}
