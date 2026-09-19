import { Module } from "@nestjs/common";
import { ProjectsModule } from "./core/projects.module";
import { ProjectsByIdModule } from "./core/projects-by-id.module";
import { BuildApprovalsModule } from "./approvals/build-approvals.module";
import { BuildClientPortalModule } from "./client-portal/build-client-portal.module";
import { BuildCommentDraftsModule } from "./comment-drafts/build-comment-drafts.module";
import { BuildExecutionModule } from "./execution/build-execution.module";
import { BuildFormsModule } from "./forms/build-forms.module";
import { BuildGovernanceModule } from "./governance/build-governance.module";
import { BuildIncidentsModule } from "./incidents/build-incidents.module";
import { BuildManagedProductsModule } from "./managed-products/managed-products.module";
import { BuildMeetingsModule } from "./meetings/build-meetings.module";
import { PmWorkspacesModule } from "./pm-workspaces/pm-workspaces.module";
import { BuildPortfoliosModule } from "./portfolios/build-portfolios.module";
import { BuildQaModule } from "./qa/build-qa.module";
import { BuildTeamsModule } from "./teams/build-teams.module";
import { BuildWorkflowModule } from "./workflow/build-workflow.module";
import { BuildCalendarModule } from "./build-calendar.module";
import { ScopeDirectoryModule } from "./scope-directory/scope-directory.module";

export const BUILD_MODULES = [
  BuildCalendarModule,
  ProjectsModule,
  ScopeDirectoryModule,
  BuildApprovalsModule,
  BuildClientPortalModule,
  BuildCommentDraftsModule,
  BuildExecutionModule,
  BuildFormsModule,
  BuildGovernanceModule,
  BuildIncidentsModule,
  BuildManagedProductsModule,
  BuildMeetingsModule,
  PmWorkspacesModule,
  BuildPortfoliosModule,
  BuildQaModule,
  BuildTeamsModule,
  BuildWorkflowModule,
  // Must stay last: its bare `build/:projectId` route shadows every literal
  // sibling registered after it. Guarded by build-route-order.spec.ts.
  ProjectsByIdModule,
];

/**
 * Aggregates every Build sub-domain so the root module imports one feature
 * module instead of sixteen. Re-exported so a consumer that imports BuildModule
 * also gets the sub-modules' exported providers.
 */
@Module({
  imports: BUILD_MODULES,
  exports: BUILD_MODULES,
})
export class BuildModule {}
