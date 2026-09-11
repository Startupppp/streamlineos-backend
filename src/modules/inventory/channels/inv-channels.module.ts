import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { InvChannelPoolsModule } from "./pools/inv-channel-pools.module";
import { InvQuickCommerceModule } from "./quick-commerce/inv-quick-commerce.module";
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
import { ChannelCommerceRegistry } from "./sync/channel-commerce.port";
import { ChannelCommerceRegistrar } from "./sync/channel-commerce.registrar";
import { ShopifyAdminAdapter } from "./sync/shopify-admin.adapter";
import { ChannelSyncService } from "./sync/channel-sync.service";
import {
  ChannelSyncController,
  ChannelSyncCronController,
} from "./sync/channel-sync.controller";

/**
 * E6 adds three routes to this module and one background sweep:
 *
 *   POST /inventory/channels/inbound/:channelId   the marketplace's, signature-gated
 *   GET  /inventory/channels/:id/snapshot-differences
 *   POST /inventory/channels/snapshot-differences/:id/{accept,dismiss}
 *   GET|POST /cron/inventory-channel-snapshot     the drain
 *
 * INV-27 adds the other direction — work we initiate — and its dead-letter box:
 *
 *   POST /inventory/channels/:id/sync/stock       queue a push + a pull
 *   POST /inventory/channels/:id/sync/orders      queue an order pull
 *   POST /inventory/channels/:id/sync/shipments   queue a ship confirm
 *   GET  /inventory/channels/:id/sync/failures    the dead-letter list
 *   POST /inventory/channels/sync/failures/:id/retry
 *   GET|POST /cron/inventory-channel-sync         the drain
 *
 * `InvStockEngineModule` for `StockEngineService` — accepting a difference posts
 * an ordinary movement through it — for `InventoryAuditService`, and for
 * `NumberSequenceService`, which is what gives an imported channel order its SO
 * number. Without the import the application does not boot.
 */
@Module({
  imports: [InvStockEngineModule, InvChannelPoolsModule, InvQuickCommerceModule],
  controllers: [
    ChannelsController,
    TplController,
    ChannelWebhookController,
    ChannelSnapshotController,
    ChannelSnapshotCronController,
    ChannelSyncController,
    ChannelSyncCronController,
  ],
  providers: [
    ChannelsService,
    TplService,
    ChannelAdapterRegistry,
    ChannelAdapterRegistrar,
    ChannelSnapshotService,
    ChannelCommerceRegistry,
    ChannelCommerceRegistrar,
    ShopifyAdminAdapter,
    ChannelSyncService,
  ],
  exports: [ChannelSnapshotService, ChannelSyncService, InvQuickCommerceModule],
})
export class InvChannelsModule {}
