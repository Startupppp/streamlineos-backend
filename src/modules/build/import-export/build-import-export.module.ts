import { Module } from "@nestjs/common";
import { TicketExportService } from "./ticket-export.service";
import { TicketImportService } from "./ticket-import.service";
import { TicketImportExportController } from "./ticket-import-export.controller";

@Module({
  controllers: [TicketImportExportController],
  providers: [TicketImportService, TicketExportService],
  exports: [TicketImportService, TicketExportService],
})
export class BuildImportExportModule {}
