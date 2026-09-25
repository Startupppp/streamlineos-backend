import { Injectable, Inject } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { and, eq, ilike, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { projects } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { KbAskService } from "../../../kb/retrieval/kb-ask.service";
import { ProjectsAiService } from "./projects-ai.service";
import {
  defineTool,
  data,
  empty,
  failed,
  type AskOsToolDefinition,
  type AskOsToolProvider,
} from "../registry/ask-os-tool.types";
import { AskOsTools } from "../registry/ask-os-tools.decorator";

@AskOsTools()
@Injectable()
export class WorkspaceInlineTools implements AskOsToolProvider {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly projectsAi: ProjectsAiService,
    private readonly moduleRef: ModuleRef,
  ) {}

  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "searchProjects",
        description:
          "Search for projects by name to get their IDs. Use before calling askProjectAI or getProjectSummary when you only have a project name.",
        input: z.object({
          query: z.string().min(1).describe("Partial project name to search"),
        }),
        permission: "build:view",
        module: "build",
        run: async ({ query }, ctx) => {
          const { orgId } = ctx.actor;
          const results = await this.db
            .select({
              id: projects.id,
              name: projects.name,
              key: projects.key,
              status: projects.status,
            })
            .from(projects)
            .where(
              and(
                eq(projects.orgId, orgId),
                ne(projects.status, "ARCHIVED"),
                ilike(projects.name, `%${query}%`),
                isNull(projects.deletedAt),
              ),
            )
            .limit(10);
          if (results.length === 0) return empty(`projects matching "${query}"`);
          return data({ results, message: `Found ${results.length} project(s).` });
        },
      }),

      defineTool({
        key: "askProjectAI",
        description:
          "Ask an AI question about a specific project — e.g. what's blocked, why is it late, what are the risks. Requires a projectId; use searchProjects first if you only have a name.",
        input: z.object({
          projectId: z.number().int().positive().describe("Numeric project ID"),
          question: z.string().min(1).describe("Question to ask about the project"),
        }),
        permission: "build:ai:use",
        module: "build",
        run: async ({ projectId, question }, ctx) => {
          const { orgId, userId } = ctx.actor;
          try {
            const result = await this.projectsAi.ask(orgId, projectId, question, userId);
            return data(result);
          } catch {
            return failed(`Project ${projectId} not found or has no ticket data.`);
          }
        },
      }),

      defineTool({
        key: "getProjectSummary",
        description:
          "Get an AI-generated summary of a project's health, progress, and highlights. Requires a projectId; use searchProjects first if you only have a name.",
        input: z.object({
          projectId: z.number().int().positive().describe("Numeric project ID"),
        }),
        permission: "build:ai:use",
        module: "build",
        run: async ({ projectId }, ctx) => {
          const { orgId, userId } = ctx.actor;
          try {
            const result = await this.projectsAi.summarize(orgId, projectId, userId);
            return data(result);
          } catch {
            return failed(`Project ${projectId} not found or has no ticket data.`);
          }
        },
      }),

      defineTool({
        key: "searchKnowledgeBase",
        description:
          "Search the organization's knowledge base (wiki pages and uploaded documents/notes) to answer the user's question with grounded information. Use this whenever the user asks about company docs, policies, uploaded files, notes, or wiki content.",
        input: z.object({
          query: z.string().describe("The question to answer from the knowledge base"),
        }),
        permission: "kb:articles:view",
        module: "kb",
        run: async ({ query }, ctx) => {
          try {
            const kbAsk = this.moduleRef.get(KbAskService, { strict: false });
            const result = await kbAsk.ask(ctx.caller, { question: query }, { companyDocuments: true });
            return data({ answer: result.answer, hasContext: result.hasContext });
          } catch {
            return failed("Knowledge base search is unavailable right now.");
          }
        },
      }),
    ];
  }
}
