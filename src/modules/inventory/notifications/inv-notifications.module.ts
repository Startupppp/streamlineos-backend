import { Module } from "@nestjs/common";
import { OutboxModule } from "../../../common/outbox/outbox.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { AccessModule } from "../../access/access.module";
import { InvExpirySweepService } from "./inv-expiry-sweep.service";
import {
  InvAdjustmentApprovalConsumerService,
  InvLotExpiringConsumerService,
  InvRecallOpenedConsumerService,
} from "./inv-notification-consumers.service";

/**
 * G3 — inventory's notification consumers, in one place.
 *
 * Low stock's consumer lives in `replenishment/` because replenishment is what a
 * low-stock signal is *for*. These three have no such home: an expiring lot, an
 * adjustment awaiting a signature and an opened recall belong to quality, stock
 * and quality respectively, and putting a notification consumer in each would
 * scatter one concern across three modules for no gain. They are one job —
 * turning an inventory event into the right people's inbox — so they are one
 * module.
 */
@Module({
  imports: [OutboxModule, NotificationsModule, AccessModule],
  providers: [
    InvExpirySweepService,
    InvLotExpiringConsumerService,
    InvAdjustmentApprovalConsumerService,
    InvRecallOpenedConsumerService,
  ],
  exports: [InvExpirySweepService],
})
export class InvNotificationsModule {}
