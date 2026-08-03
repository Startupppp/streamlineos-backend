import { Injectable } from "@nestjs/common";
import { ProjectsProvisionService } from "./projects-provision.service";
import { ProjectsQueryService } from "./projects-query.service";
import { ProjectsWriteService } from "./projects-write.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreateProjectInput,
  FromDealInput,
  LinkManagedProductInput,
  ListProjectsInput,
  UpdateProjectInput,
} from "./dto/projects.schemas";

@Injectable()
export class ProjectsService {
  constructor(
    private readonly provision: ProjectsProvisionService,
    private readonly projectsQuery: ProjectsQueryService,
    private readonly projectsWrite: ProjectsWriteService,
  ) {}

  async listProjects(u: CurrentUserContext, input: ListProjectsInput) {
    return this.projectsQuery.listProjects(u, input);
  }

  async createProject(
    orgId: string,
    creatorUserId: string,
    input: CreateProjectInput,
  ) {
    return this.provision.createProject(orgId, creatorUserId, input);
  }

  async createFromDeal(orgId: string, userId: string, input: FromDealInput) {
    return this.provision.createFromDeal(orgId, userId, input);
  }

  async getProject(u: CurrentUserContext, projectId: number) {
    return this.projectsQuery.getProject(u, projectId);
  }

  async updateProject(
    u: CurrentUserContext,
    projectId: number,
    body: UpdateProjectInput,
  ) {
    return this.projectsWrite.updateProject(u, projectId, body);
  }

  async deleteProject(u: CurrentUserContext, projectId: number) {
    return this.projectsWrite.deleteProject(u, projectId);
  }

  async linkProjectToManagedProduct(
    u: CurrentUserContext,
    projectId: number,
    input: LinkManagedProductInput,
  ) {
    return this.projectsWrite.linkProjectToManagedProduct(
      u,
      projectId,
      input,
    );
  }
}
