import { Module } from "@nestjs/common";
import { AttributionReportService } from "./attribution-report.service";

/**
 * The weighting library's runtime home.
 *
 * No controller of its own: the report answers the same question the shipped
 * first/last-touch endpoints answer, so it belongs on the same surface rather
 * than at a second address a client has to discover. `CrmModule` imports this
 * and `CrmCampaignsController` exposes it — the dependency runs one way, so
 * there is no forwardRef and no cycle.
 */
@Module({
  providers: [AttributionReportService],
  exports: [AttributionReportService],
})
export class AttributionModule {}
