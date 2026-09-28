import { Module } from "@nestjs/common";
import { ProjectsModule } from "../projects.module";
import { ProjectsByIdController } from "./projects-by-id.controller";

@Module({
  imports: [ProjectsModule],
  controllers: [ProjectsByIdController],
})
export class ProjectsByIdModule {}
