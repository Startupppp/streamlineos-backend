import { Module } from "@nestjs/common";
import { ProjectsModule } from "./core/projects.module";
import { ProjectsByIdModule } from "./core/projects-by-id.module";
import { ProjectsApprovalsModule } from "./approvals/projects-approvals.module";
import { ProjectsClientPortalModule } from "./client-portal/projects-client-portal.module";
import { ProjectsCommentDraftsModule } from "./comment-drafts/projects-comment-drafts.module";
import { ProjectsExecutionModule } from "./execution/projects-execution.module";
import { ProjectsFormsModule } from "./forms/projects-forms.module";
import { ProjectsGovernanceModule } from "./governance/projects-governance.module";
import { ProjectsIncidentsModule } from "./incidents/projects-incidents.module";
import { ProjectsManagedProductsModule } from "./managed-products/managed-products.module";
import { ProjectsMeetingsModule } from "./meetings/projects-meetings.module";
import { PmWorkspacesModule } from "./pm-workspaces/pm-workspaces.module";
import { ProjectsPortfoliosModule } from "./portfolios/projects-portfolios.module";
import { ProjectsQaModule } from "./qa/projects-qa.module";
import { ProjectsTeamsModule } from "./teams/projects-teams.module";
import { ProjectsWorkflowModule } from "./workflow/projects-workflow.module";

const BUILD_MODULES = [
  ProjectsModule,
  ProjectsByIdModule,
  ProjectsApprovalsModule,
  ProjectsClientPortalModule,
  ProjectsCommentDraftsModule,
  ProjectsExecutionModule,
  ProjectsFormsModule,
  ProjectsGovernanceModule,
  ProjectsIncidentsModule,
  ProjectsManagedProductsModule,
  ProjectsMeetingsModule,
  PmWorkspacesModule,
  ProjectsPortfoliosModule,
  ProjectsQaModule,
  ProjectsTeamsModule,
  ProjectsWorkflowModule,
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
