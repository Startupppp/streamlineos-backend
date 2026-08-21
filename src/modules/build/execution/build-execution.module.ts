import { Module } from "@nestjs/common";
import { ProjectsModule } from "../../build/core/projects.module";
import { TimesheetsCoreModule } from "../../timesheets/core/timesheets-core.module";
import {
  CyclesController,
  EpicsController,
  ModulesController,
  SprintsController,
} from "./iterations.controller";
import { SprintsService } from "./sprints.service";
import { CyclesService } from "./cycles.service";
import { ModulesService } from "./modules.service";
import { EpicsService } from "./epics.service";
import {
  IntakeController,
  MilestonesController,
  ViewsController,
  WhiteboardsController,
  WhiteboardsHubController,
  WorkspaceViewsController,
} from "./workspace.controller";
import {
  IntakeService,
  MilestonesService,
  ViewsService,
} from "./workspace.service";
import { WhiteboardsService } from "./whiteboards.service";
import {
  PublicWhiteboardLinksController,
  WhiteboardSharingController,
} from "./whiteboard-sharing.controller";
import { WhiteboardSharingService } from "./whiteboard-sharing.service";
import {
  BillingSummaryController,
  TicketTimeEntriesController,
  TimeEntriesController,
} from "./timesheets.controller";
import { TimesheetsService } from "./timesheets.service";

@Module({
  imports: [ProjectsModule, TimesheetsCoreModule],
  controllers: [
    SprintsController,
    CyclesController,
    ModulesController,
    EpicsController,
    MilestonesController,
    IntakeController,
    WorkspaceViewsController,
    ViewsController,
    WhiteboardsController,
    WhiteboardsHubController,
    WhiteboardSharingController,
    PublicWhiteboardLinksController,
    TimeEntriesController,
    BillingSummaryController,
    TicketTimeEntriesController,
  ],
  providers: [
    SprintsService,
    CyclesService,
    ModulesService,
    EpicsService,
    MilestonesService,
    IntakeService,
    ViewsService,
    WhiteboardsService,
    WhiteboardSharingService,
    TimesheetsService,
  ],
})
export class BuildExecutionModule {}
