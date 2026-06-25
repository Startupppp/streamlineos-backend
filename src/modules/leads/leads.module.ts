import { Module } from "@nestjs/common";
import { LeadsController } from "./leads.controller";
import { LeadsIngestController } from "./leads.ingest.controller";
import { LeadsService } from "./leads.service";

@Module({ controllers: [LeadsController, LeadsIngestController], providers: [LeadsService] })
export class LeadsModule {}
