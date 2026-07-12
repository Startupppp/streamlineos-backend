import { Module } from "@nestjs/common";
import { ProjectsModule } from "../projects/projects.module";
import {
  CyclesController,
  EpicsController,
  ModulesController,
  SprintsController,
} from "./iterations.controller";
import {
  CyclesService,
  EpicsService,
  ModulesService,
  SprintsService,
} from "./iterations.service";
import {
  IntakeController,
  MilestonesController,
  PagesController,
  ViewsController,
  WhiteboardsController,
  WhiteboardsHubController,
  WorkspaceViewsController,
} from "./workspace.controller";
import {
  IntakeService,
  MilestonesService,
  PagesService,
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
  imports: [ProjectsModule],
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
    PagesController,
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
    PagesService,
    TimesheetsService,
  ],
})
export class ProjectsExecutionModule {}
