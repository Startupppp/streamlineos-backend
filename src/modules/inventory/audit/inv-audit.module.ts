import { Module } from "@nestjs/common";
import { InvAuditEventsController } from "./inv-audit-events.controller";
import { InvAuditEventsService } from "./inv-audit-events.service";

@Module({
  controllers: [InvAuditEventsController],
  providers: [InvAuditEventsService],
  exports: [InvAuditEventsService],
})
export class InvAuditModule {}
