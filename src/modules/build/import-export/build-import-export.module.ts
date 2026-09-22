import { Module } from "@nestjs/common";
import { TicketExportService } from "./ticket-export.service";
import { TicketImportService } from "./ticket-import.service";

@Module({
  providers: [TicketImportService, TicketExportService],
  exports: [TicketImportService, TicketExportService],
})
export class BuildImportExportModule {}
