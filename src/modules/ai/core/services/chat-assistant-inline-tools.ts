import { tool } from "ai";
import { and, eq, ilike, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { projects } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { KbAskService } from "../../../kb/retrieval/kb-ask.service";
import { ToolAccessService } from "../tool-access.service";
import { ProjectsAiService } from "./projects-ai.service";
import { ModuleRef } from "@nestjs/core";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";

interface InlineToolDeps {
  db: Db;
  orgId: string;
  userId: string;
  actor: CurrentUserContext;
  toolAccess: ToolAccessService;
  projectsAi: ProjectsAiService;
  moduleRef: ModuleRef;
}

export function buildInlineTools(deps: InlineToolDeps) {
  const { db, orgId, userId, actor, toolAccess, projectsAi, moduleRef } = deps;

  return {
    searchProjects: tool({
      description:
        "Search for projects by name to get their IDs. Use before calling askProjectAI or getProjectSummary when you only have a project name.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Partial project name to search"),
      }),
      execute: async ({ query }) => {
        const deny = await toolAccess.denyReason(orgId, userId, "build:view");
        if (deny) return { denied: true, reason: deny };

        const results = await db
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
        if (results.length === 0)
          return {
            results: [],
            message: `No projects found matching "${query}".`,
          };
        return { results, message: `Found ${results.length} project(s).` };
      },
    }),

    askProjectAI: tool({
      description:
        "Ask an AI question about a specific project — e.g. what's blocked, why is it late, what are the risks. Requires a projectId; use searchProjects first if you only have a name.",
      inputSchema: z.object({
        projectId: z.number().int().positive().describe("Numeric project ID"),
        question: z
          .string()
          .min(1)
          .describe("Question to ask about the project"),
      }),
      execute: async ({ projectId, question }) => {
        const deny = await toolAccess.denyReason(orgId, userId, "build:ai:use");
        if (deny) return { denied: true, reason: deny };

        try {
          return await projectsAi.ask(orgId, projectId, question, userId);
        } catch {
          return {
            success: false,
            message: `Project ${projectId} not found or has no ticket data.`,
          };
        }
      },
    }),

    getProjectSummary: tool({
      description:
        "Get an AI-generated summary of a project's health, progress, and highlights. Requires a projectId; use searchProjects first if you only have a name.",
      inputSchema: z.object({
        projectId: z.number().int().positive().describe("Numeric project ID"),
      }),
      execute: async ({ projectId }) => {
        const deny = await toolAccess.denyReason(orgId, userId, "build:ai:use");
        if (deny) return { denied: true, reason: deny };

        try {
          return await projectsAi.summarize(orgId, projectId, userId);
        } catch {
          return {
            success: false,
            message: `Project ${projectId} not found or has no ticket data.`,
          };
        }
      },
    }),

    searchKnowledgeBase: tool({
      description:
        "Search the organization's knowledge base (wiki pages and uploaded documents/notes) to answer the user's question with grounded information. Use this whenever the user asks about company docs, policies, uploaded files, notes, or wiki content.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("The question to answer from the knowledge base"),
      }),
      execute: async ({ query }) => {
        const deny = await toolAccess.denyReason(
          orgId,
          userId,
          "kb:articles:view",
        );
        if (deny) return { denied: true, reason: deny };

        try {
          const kbAsk = moduleRef.get(KbAskService, { strict: false });
          const result = await kbAsk.ask(actor, { question: query });
          return { answer: result.answer, hasContext: result.hasContext };
        } catch {
          return {
            answer: "Knowledge base search is unavailable right now.",
            hasContext: false,
          };
        }
      },
    }),
  };
}
