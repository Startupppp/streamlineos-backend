import { Module } from "@nestjs/common";
import { CsatController } from "./csat.controller";
import { CsatService } from "./csat.service";

@Module({ controllers: [CsatController], providers: [CsatService] })
export class CsatModule {}
