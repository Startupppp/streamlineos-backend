import { Module } from "@nestjs/common";
import { InvStockEngineModule } from "../stock-engine/inv-stock-engine.module";
import { AuditExportController } from "./audit-export.controller";
import { AuditExportService } from "./audit-export.service";

@Module({
  imports: [InvStockEngineModule],
  controllers: [AuditExportController],
  providers: [AuditExportService],
  exports: [AuditExportService],
})
export class InvAuditExportModule {}
