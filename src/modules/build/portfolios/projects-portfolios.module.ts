import { Module } from "@nestjs/common";
import { PortfoliosController } from "./portfolios.controller";
import { PortfoliosService } from "./portfolios.service";
import { ProgramsController } from "./programs.controller";
import { ProgramsService } from "./programs.service";

@Module({
  controllers: [PortfoliosController, ProgramsController],
  providers: [PortfoliosService, ProgramsService],
})
export class ProjectsPortfoliosModule {}
