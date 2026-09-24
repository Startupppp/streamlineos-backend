import { ConflictException, NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { jobTemplates } from "../../../../db/schema/hr/hiring-core";
import type { Db } from "../../../../db/drizzle.module";
import { drizzleUniqueViolation } from "../../../../test/postgres-error-fixture";
import { JobTemplatesService, type JobTemplateRow } from "./job-templates.service";
import { applyJobTemplateSchema, jobTemplateListSchema } from "./job-templates.schemas";

const dialect = new PgDialect();

/** The predicate as the database will see it, so an assertion reads the real WHERE and not a mock's memory of it. */
function renderedSql(where: SQL | undefined): string {
  return where === undefined ? "" : dialect.sqlToQuery(where).sql;
}

const TEMPLATE: JobTemplateRow = {
  id: 11,
  name: "Senior Backend Engineer — India",
  title: "Senior Backend Engineer",
  description: "Own the ledger services.",
  requirements: "5 years of Postgres.",
  benefits: "Health cover.",
  type: "FULL_TIME",
  experience: "5-8 years",
  screeningQuestions: [
    { id: "q1", question: "Notice period?", type: "TEXT", required: true, knockout: false },
  ],
  jobLevelId: 4,
  createdAt: new Date("2026-01-05T10:00:00.000Z"),
  updatedAt: new Date("2026-01-05T10:00:00.000Z"),
};

interface Harness {
  db: Db;
  /** Every WHERE the service built, in call order, rendered to SQL text. */
  predicates: string[];
  updates: Record<string, unknown>[];
  inserts: Record<string, unknown>[];
}

/**
 * A database double that records the predicate rather than inventing one.
 *
 * It answers with `rows` and captures every `where` the builder received, so a
 * test can assert on the SQL the service actually asks for. A double that only
 * returned rows would pass whether or not the service filtered anything.
 */
function buildDb(rows: unknown[], onWrite?: () => never): Harness {
  const predicates: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];

  const capture = (where: SQL | undefined) => {
    predicates.push(renderedSql(where));
    const settled = Promise.resolve(rows);
    return Object.assign(settled, {
      orderBy: () => ({ limit: () => Promise.resolve(rows) }),
      limit: () => Promise.resolve(rows),
      returning: () => {
        if (onWrite) onWrite();
        return Promise.resolve(rows);
      },
    });
  };

  const db = {
    select: () => ({ from: () => ({ where: capture }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: capture };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserts.push(values);
        return {
          returning: () => {
            if (onWrite) onWrite();
            return Promise.resolve(rows);
          },
        };
      },
    }),
  };

  return { db: db as unknown as Db, predicates, updates, inserts };
}

function serviceOver(rows: unknown[], onWrite?: () => never) {
  const harness = buildDb(rows, onWrite);
  return { service: new JobTemplatesService(harness.db), harness };
}

describe("a template name is reserved per organization, never across the platform", () => {
  /**
   * The harm: a bare `UNIQUE (name)` would let whichever tenant saved
   * "Software Engineer" first block that name for every other tenant on the
   * platform — and the second tenant would read the 409 as a bug in their own
   * data, because from where they sit the name is unused.
   */
  it("declares the unique index on (org_id, name), not on name alone", () => {
    const config = getTableConfig(jobTemplates);
    const nameIndex = config.indexes.find((index) => index.config.name === "uq_job_templates_org_name");

    expect(nameIndex).toBeDefined();
    expect(nameIndex?.config.unique).toBe(true);

    const columns = (nameIndex?.config.columns ?? []).map((column) =>
      "name" in column && typeof column.name === "string" ? column.name : String(column),
    );
    expect(columns).toEqual(["org_id", "name"]);
  });

  /**
   * The harm: a full unique index would refuse the ordinary way to replace a
   * template — delete it, save a new one under the same name — forever, because
   * the soft-deleted row never leaves the table.
   */
  it("scopes that index to live rows so a deleted name can be reused", () => {
    const config = getTableConfig(jobTemplates);
    const nameIndex = config.indexes.find((index) => index.config.name === "uq_job_templates_org_name");

    expect(nameIndex?.config.where).toBeDefined();
    expect(renderedSql(nameIndex?.config.where)).toContain('"deleted_at" is null');
  });

  /**
   * The harm: `DrizzleQueryError` carries no `code` of its own, so the obvious
   * `err.code === "23505"` never matches and a duplicate name surfaces as a 500
   * — an unhandled error page for a recruiter who simply reused a name.
   */
  it("answers a duplicate name with 409, reading the SQLSTATE through drizzle's wrapper", async () => {
    const { service } = serviceOver([], () => {
      throw drizzleUniqueViolation("uq_job_templates_org_name");
    });

    await expect(
      service.create("org_1", "user_1", { name: "Software Engineer" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  /** Paired with the negative above: an unrelated failure must NOT be relabelled a conflict. */
  it("lets a non-unique failure through rather than mislabelling every write a conflict", async () => {
    const { service } = serviceOver([], () => {
      throw new Error("connection terminated unexpectedly");
    });

    await expect(service.create("org_1", "user_1", { name: "Software Engineer" })).rejects.toThrow(
      "connection terminated unexpectedly",
    );
  });
});

describe("a soft-deleted template is invisible to every read and write", () => {
  /**
   * The harm: `deleted_at` is set rather than the row removed, so a read that
   * forgets the predicate serves deleted templates in the library picker. The
   * recruiter then stamps a posting from a template someone retired on purpose.
   */
  it("filters deleted rows out of the list", async () => {
    const { service, harness } = serviceOver([]);
    await service.list("org_1", jobTemplateListSchema.parse({}));

    expect(harness.predicates).toHaveLength(1);
    expect(harness.predicates[0]).toContain('"deleted_at" is null');
    expect(harness.predicates[0]).toContain('"org_id" =');
  });

  it("filters deleted rows out of a single fetch", async () => {
    const { service, harness } = serviceOver([TEMPLATE]);
    await service.getOne("org_1", 11);

    expect(harness.predicates[0]).toContain('"deleted_at" is null');
  });

  /**
   * The harm: an UPDATE without the predicate resurrects a deleted template's
   * content — and worse, a name change on a deleted row can collide with a live
   * one the moment the row is ever restored.
   */
  it("refuses to update a deleted template, and reports it missing rather than silently doing nothing", async () => {
    const { service, harness } = serviceOver([]);

    await expect(service.update("org_1", 11, { name: "Renamed" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(harness.predicates[0]).toContain('"deleted_at" is null');
  });

  /**
   * The harm: without `deleted_at IS NULL` in the predicate a second delete
   * reports success and pushes the timestamp forward, so an audit trail dates
   * the removal to whenever someone last clicked the button.
   */
  it("refuses to delete an already-deleted template", async () => {
    const { service, harness } = serviceOver([]);

    await expect(service.remove("org_1", 11)).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.predicates[0]).toContain('"deleted_at" is null');
    expect(harness.updates[0]).toHaveProperty("deletedAt");
  });

  /** Paired positive: the same call succeeds when the row is live, so the negatives above are not passing on a broken chain. */
  it("deletes a live template", async () => {
    const { service, harness } = serviceOver([{ id: 11 }]);

    await expect(service.remove("org_1", 11)).resolves.toBeUndefined();
    expect(harness.updates).toHaveLength(1);
  });

  /** The list is a keyset page, and the cap is the platform's, not the caller's. */
  it("never fetches more than the platform page cap however large a limit is asked for", async () => {
    const { service } = serviceOver([]);
    const query = jobTemplateListSchema.parse({ limit: "5000" });

    expect(query.limit).toBeLessThanOrEqual(100);
    await expect(service.list("org_1", query)).resolves.toMatchObject({
      pagination: { limit: query.limit },
    });
  });
});

describe("applying a template fills gaps and never overrules the recruiter", () => {
  /**
   * The harm this prevents is the reason the feature exists at all: a picker
   * that overwrote what the recruiter had already typed would be destructive,
   * so nobody would touch it once they had entered anything — and the job
   * descriptions would go on being retyped from memory.
   */
  it("keeps every field the caller set and fills only the ones they left out", async () => {
    const { service } = serviceOver([TEMPLATE]);
    const draft = applyJobTemplateSchema.parse({
      title: "Staff Backend Engineer",
      description: "Rewritten for this opening.",
      location: "Bengaluru",
    });

    const applied = await service.applyToJob("org_1", 11, draft);

    expect(applied.draft.title).toBe("Staff Backend Engineer");
    expect(applied.draft.description).toBe("Rewritten for this opening.");
    expect(applied.draft.requirements).toBe(TEMPLATE.requirements);
    expect(applied.draft.benefits).toBe(TEMPLATE.benefits);
    expect(applied.draft.experience).toBe(TEMPLATE.experience);
    expect(applied.draft.screeningQuestions).toEqual(TEMPLATE.screeningQuestions);
  });

  /**
   * The harm: `type` carries a column default, so a merge written as
   * `draft.type ?? template.type` looks correct while a schema default silently
   * turns "the caller said nothing" into "the caller said FULL_TIME". The
   * distinction is key presence, which is why the schema is `.optional()` and
   * `.strict()` rather than nullable.
   */
  it("treats an explicitly chosen employment type as the caller's, not the template's", async () => {
    const { service } = serviceOver([TEMPLATE]);
    const draft = applyJobTemplateSchema.parse({ type: "CONTRACT" });

    const applied = await service.applyToJob("org_1", 11, draft);

    expect(applied.draft.type).toBe("CONTRACT");
    expect(TEMPLATE.type).toBe("FULL_TIME");
  });

  /**
   * The harm: the template deliberately has no `status`, `openings` or
   * deadline. A merge that reached for those would copy a lifecycle a template
   * cannot own, and a spread written the other way round (`{...template,
   * ...draft}`) would quietly drop them instead.
   */
  it("passes through the posting fields a template has no opinion on", async () => {
    const { service } = serviceOver([TEMPLATE]);
    const draft = applyJobTemplateSchema.parse({
      location: "Remote",
      openings: 3,
      status: "OPEN",
      salaryMin: 2_000_000,
      applicationDeadline: "2026-03-31",
    });

    const applied = await service.applyToJob("org_1", 11, draft);

    expect(applied.draft.location).toBe("Remote");
    expect(applied.draft.openings).toBe(3);
    expect(applied.draft.status).toBe("OPEN");
    expect(applied.draft.salaryMin).toBe(2_000_000);
    expect(applied.draft.applicationDeadline).toBe("2026-03-31");
  });

  /** An empty draft is the ordinary first use of the picker: take the template whole. */
  it("takes the whole template when the recruiter has typed nothing yet", async () => {
    const { service } = serviceOver([TEMPLATE]);

    const applied = await service.applyToJob("org_1", 11, applyJobTemplateSchema.parse({}));

    expect(applied.draft.title).toBe(TEMPLATE.title);
    expect(applied.draft.type).toBe(TEMPLATE.type);
    expect(applied.jobTemplateId).toBe(TEMPLATE.id);
    expect(applied.jobTemplateName).toBe(TEMPLATE.name);
  });

  /**
   * The harm: a cross-tenant id must read as absent, not as forbidden. A 403
   * here would confirm that some other organization owns a template with that
   * id (BE-91).
   */
  it("reports another tenant's template as missing", async () => {
    const { service, harness } = serviceOver([]);

    await expect(
      service.applyToJob("org_2", 11, applyJobTemplateSchema.parse({})),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.predicates[0]).toContain('"org_id" =');
  });
});
