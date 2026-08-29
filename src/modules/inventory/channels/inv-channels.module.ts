import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { ChannelsController } from "./channels.controller";
import { TplController } from "./tpl.controller";
import { ChannelsService } from "./channels.service";
import { TplService } from "./tpl.service";
import { ChannelAdapterRegistry } from "./channel-adapter";
import { ChannelAdapterRegistrar } from "./fake-channel-adapter";
import { ChannelSnapshotService } from "./channel-snapshot.service";
import { ChannelWebhookController } from "./channel-webhook.controller";
import {
  ChannelSnapshotController,
  ChannelSnapshotCronController,
} from "./channel-snapshot.controller";

/**
 * E6 adds three routes to this module and one background sweep:
 *
 *   POST /inventory/channels/inbound/:channelId   the marketplace's, signature-gated
 *   GET  /inventory/channels/:id/snapshot-differences
 *   POST /inventory/channels/snapshot-differences/:id/{accept,dismiss}
 *   GET|POST /cron/inventory-channel-snapshot     the drain
 *
 * `InvStockEngineModule` for `StockEngineService` — accepting a difference posts
 * an ordinary movement through it — and for `InventoryAuditService`. Without the
 * import the application does not boot.
 */
@Module({
  imports: [InvStockEngineModule],
  controllers: [
    ChannelsController,
    TplController,
    ChannelWebhookController,
    ChannelSnapshotController,
    ChannelSnapshotCronController,
  ],
  providers: [
    ChannelsService,
    TplService,
    ChannelAdapterRegistry,
    ChannelAdapterRegistrar,
    ChannelSnapshotService,
  ],
  exports: [ChannelSnapshotService],
})
export class InvChannelsModule {}
