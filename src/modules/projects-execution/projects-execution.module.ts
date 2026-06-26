import { Module } from "@nestjs/common";
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
} from "./workspace.controller";
import {
  IntakeService,
  MilestonesService,
  PagesService,
  ViewsService,
  WhiteboardsService,
} from "./workspace.service";
import {
  BillingSummaryController,
  TicketTimeEntriesController,
  TimeEntriesController,
} from "./timesheets.controller";
import { TimesheetsService } from "./timesheets.service";

@Module({
  controllers: [
    SprintsController,
    CyclesController,
    ModulesController,
    EpicsController,
    MilestonesController,
    IntakeController,
    ViewsController,
    WhiteboardsController,
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
    PagesService,
    TimesheetsService,
  ],
})
export class ProjectsExecutionModule {}
