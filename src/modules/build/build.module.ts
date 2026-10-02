import { Module } from "@nestjs/common";
import { ProjectsModule, ProjectsByIdModule, ProjectsRetentionSettingsModule } from "./core";
import { BuildApprovalsModule } from "./approvals/build-approvals.module";
import { BuildClientPortalModule } from "./client-portal/build-client-portal.module";
import { BuildCommentDraftsModule } from "./comment-drafts/build-comment-drafts.module";
import { BuildExecutionModule } from "./execution/build-execution.module";
import { BuildFormsModule } from "./forms/build-forms.module";
import { BuildGovernanceModule } from "./governance/build-governance.module";
import { BuildImportExportModule } from "./import-export/build-import-export.module";
import { BuildIncidentsModule } from "./incidents/build-incidents.module";
import { BuildManagedProductsModule } from "./managed-products/managed-products.module";
import { BuildMeetingsModule } from "./meetings/build-meetings.module";
import { BuildPortfoliosModule } from "./portfolios/build-portfolios.module";
import { BuildQaModule } from "./qa/build-qa.module";
import { BuildTeamsModule } from "./teams/build-teams.module";
import { BuildFilesModule } from "./files/build-files.module";
import { BuildUpdatesModule } from "./updates/build-updates.module";
import { BuildWorkflowModule } from "./workflow/build-workflow.module";
import { BuildCalendarModule } from "./build-calendar.module";
import { ScopeDirectoryModule } from "./scope-directory/scope-directory.module";

export const BUILD_MODULES = [
  BuildCalendarModule,
  ProjectsModule,
  ScopeDirectoryModule,
  ProjectsRetentionSettingsModule,
  BuildApprovalsModule,
  BuildClientPortalModule,
  BuildCommentDraftsModule,
  BuildExecutionModule,
  BuildFormsModule,
  BuildGovernanceModule,
  BuildImportExportModule,
  BuildIncidentsModule,
  BuildManagedProductsModule,
  BuildMeetingsModule,
  BuildPortfoliosModule,
  BuildQaModule,
  BuildFilesModule,
  BuildTeamsModule,
  BuildUpdatesModule,
  BuildWorkflowModule,
  ProjectsByIdModule,
];

@Module({
  imports: BUILD_MODULES,
  exports: BUILD_MODULES,
})
export class BuildModule {}
