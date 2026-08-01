import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { feedbucketSubmissions, feedbucketWidgets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import type { PublicSubmitInput } from "./feedbucket.schemas";

type WidgetRow = typeof feedbucketWidgets.$inferSelect;

@Injectable()
export class FeedbucketPublicService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async resolveWidget(publicKey: string): Promise<WidgetRow | null> {
    const widget = await withPublicToken(this.db, publicKey, (tx) =>
      tx.query.feedbucketWidgets.findFirst({
        where: and(
          eq(feedbucketWidgets.publicKey, publicKey),
          eq(feedbucketWidgets.isActive, true),
          isNull(feedbucketWidgets.deletedAt),
        ),
      }),
    );
    return widget ?? null;
  }

  async createSubmission(
    widget: WidgetRow,
    dto: PublicSubmitInput,
    screenshotUrl?: string,
  ): Promise<number> {
    const [submission] = await this.db
      .insert(feedbucketSubmissions)
      .values({
        orgId: widget.orgId,
        widgetId: widget.id,
        type: dto.type,
        message: dto.message,
        pageUrl: dto.pageUrl,
        reporterName: dto.reporterName,
        reporterEmail: dto.reporterEmail,
        metadata: dto.metadata,
        consoleLogs: dto.consoleLogs,
        networkLogs: dto.networkLogs,
        screenshotUrl,
        status: "open",
      })
      .returning({ id: feedbucketSubmissions.id });
    if (!submission) throw new Error("Failed to create feedbucket submission");
    return submission.id;
  }
}
