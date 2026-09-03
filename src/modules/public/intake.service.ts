import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { intakeItems, projects } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { sanitizeText } from "./public.helpers";
import type { IntakeInput } from "./dto/public.schemas";

@Injectable()
export class IntakeService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * WHAT THIS ROUTE IS, STATED PLAINLY. `POST /public/intake/:projectId` is `@Public()`
   * and addressed by a SEQUENTIAL INTEGER — no token, no per-project opt-in. Every one of
   * its five siblings on the same controller (forms, lead-form, nps, vendor-portal,
   * external-referral) is addressed by an unguessable token instead. Migration 0385's own
   * header records the gap and declines to close it: "that is the app's existing, pre-RLS
   * design, not something this migration should change." It is still open. Two consequences
   * this method CANNOT repair, because closing them means changing the address and every
   * deployed intake link with it:
   *
   *   - an unauthenticated caller can file an intake item into any tenant's live project;
   *   - 201 for a project id that exists and 400 for one that does not is a platform-wide
   *     existence oracle, walkable one integer at a time.
   *
   * Both need a per-project token (a migration, a new public route, and the frontend page
   * at `app/(public)/intake/[projectId]`), which is a scheduled change, not a release fix.
   * The rate limit on `public:intake` is what bounds the enumeration in the meantime.
   *
   * WHAT IT DOES REPAIR. `app.resolve_project_org_id` is SECURITY DEFINER and answers for
   * ANY row in `build.projects`, deleted ones included — that is its job, and its comment
   * says "never expose any other project column through this path". It resolves the tenant;
   * it does not decide eligibility. HEAD treated the resolver's answer as the whole
   * decision, so a project that had been deleted still accepted anonymous writes, and the
   * rows landed where the deletion had already removed everything that would show them.
   * The row is re-read below inside the tenant transaction, where RLS is live and
   * `app.organization_id` is the org the resolver named — the same shape the calendar
   * provider webhook uses for exactly this problem: resolve the tenant outside, enforce the
   * predicate against the real row inside.
   */
  async submitIntake(projectId: number, input: IntakeInput) {
    const rows = await this.db.execute(
      sql`SELECT app.resolve_project_org_id(${projectId}) AS org_id`,
    );
    const orgId = rows[0]?.org_id ? String(rows[0].org_id) : null;

    if (!orgId) throw new BadRequestException("Invalid request");

    const sanitizedTitle = sanitizeText(input.title);
    const sanitizedDescription = input.description
      ? sanitizeText(input.description)
      : undefined;

    const item = await runInTenantTransaction(
      this.db,
      async (tx) => {
        // Under RLS, and therefore against a row that is provably this tenant's. Returning
        // null falls through to the SAME `BadRequestException("Invalid request")` that an
        // unresolved project id already produces, so refusing here adds no second answer
        // for an anonymous caller to tell apart from the first.
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
          .limit(1);
        if (!project) return null;

        const [inserted] = await tx
          .insert(intakeItems)
          .values({
            projectId,
            orgId,
            title: sanitizedTitle,
            description: sanitizedDescription
              ? {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: sanitizedDescription }],
                    },
                  ],
                }
              : null,
            source: "web_form",
            submitterEmail: input.submitterEmail ?? null,
            submitterName: input.submitterName ?? null,
            priority: input.priority ?? null,
            requestType: input.requestType ?? null,
          })
          .returning({ id: intakeItems.id });
        return inserted;
      },
      { orgId },
    );

    if (!item) throw new BadRequestException("Invalid request");

    return { id: item.id, message: "Request submitted successfully" };
  }
}
