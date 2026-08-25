import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

/**
 * A ratchet over the identity migration, held while it is in progress.
 *
 * Phase 2 moves every reader of `leads`, `clients` and `contacts` onto Party and
 * then drops those tables. That runs as five independent batches over five
 * modules, so for most of the phase the old tables still exist and still work —
 * which is exactly the window in which somebody adds a fifty-first call site in
 * good faith and nothing complains.
 *
 * Ticket 08 asks for this at contract time. It is here now because a guard that
 * arrives after the migration cannot prevent the migration regressing during it,
 * and "we all know not to use those tables" is the kind of convention that holds
 * right up until the person who knows is on holiday.
 *
 * The list may only shrink. Both directions are enforced:
 *
 *   - a file NOT on the list that imports one of these tables fails the build,
 *     which is the regression this exists to stop;
 *   - a file ON the list that no longer imports one also fails, so the list
 *     cannot rot into a stale allowlist that quietly permits anything.
 *
 * When it reaches zero, `contacts`, `clients` and `leads` have no readers left
 * and ticket 08 can drop them.
 */
describe("the legacy identity tables gain no new readers", () => {
  /**
   * Every file importing `leads`, `clients` or `contacts` from the schema, as of
   * the start of Phase 2. Delete lines as each migrate batch lands; never add one.
   */
  const KNOWN_READERS = [
  "src/modules/ai/core/crm-copilot-tools.ts",
  "src/modules/ai/core/services/chat-assistant-context.ts",
  "src/modules/ai/core/services/crm-brief.service.ts",
  "src/modules/ai/core/services/crm-copilot.service.ts",
  "src/modules/ai/core/services/crm-pipeline.service.ts",
  "src/modules/ai/core/services/crm-scoring.service.ts",
  "src/modules/ai/core/services/crm-tasks.service.ts",
  "src/modules/clients/client-opportunities.service.ts",
  "src/modules/clients/clients.service.ts",
  "src/modules/contacts/contact-roles.service.ts",
  "src/modules/contacts/contacts.service.ts",
  "src/modules/crm/automation-studio/crm-automation-runner.service.ts",
  "src/modules/crm/automation-studio/crm-sequences-runner.service.ts",
  "src/modules/crm/consent/crm-consent.service.ts",
  "src/modules/crm/core/crm-attribution-report.service.ts",
  "src/modules/crm/core/crm-campaigns.service.ts",
  "src/modules/crm/core/crm-customer360-sections.service.ts",
  "src/modules/crm/core/crm-customer360.service.ts",
  "src/modules/crm/core/crm-org-merge.service.ts",
  "src/modules/crm/core/crm-organizations.service.ts",
  "src/modules/crm/core/crm-rules.service.ts",
  "src/modules/crm/core/crm-sales-dashboard.service.ts",
  "src/modules/crm/core/crm-sla.service.ts",
  "src/modules/crm/entity/crm-entity.adapter.ts",
  "src/modules/crm/inbox/crm-inbox-ai-actions.service.ts",
  "src/modules/crm/inbox/crm-inbox.service.ts",
  "src/modules/crm/metadata/crm-data-quality.service.ts",
  "src/modules/crm/metadata/crm-validation.service.ts",
  "src/modules/cron/cron-weekly-recap.service.ts",
  "src/modules/dashboard/dashboard-crm.service.ts",
  "src/modules/deals/deals-stakeholders.service.ts",
  "src/modules/inventory/returns/customer-returns.service.ts",
  "src/modules/leads/duplicate-leads.ts",
  "src/modules/leads/lead-status.service.ts",
  "src/modules/leads/lead-triggers.ts",
  "src/modules/leads/leads-board.service.ts",
  "src/modules/leads/leads-detail.service.ts",
  "src/modules/leads/leads-exports.service.ts",
  "src/modules/leads/leads-ops.service.ts",
  "src/modules/leads/leads-read.service.ts",
  "src/modules/leads/leads-reports-team.service.ts",
  "src/modules/leads/leads-reports.service.ts",
  "src/modules/leads/leads.controller.e2e-spec.ts",
  "src/modules/leads/leads.service.ts",
  // The seam itself, plus what writes through it and what checks it. Not call
  // sites to migrate -- they are what everything else migrates ONTO, and they
  // import the legacy tables for the same reason `party-legacy-seam.ts` always
  // has: something must name the table it is standing in for. When this list
  // reaches only these, ticket 08 can drop the tables and these files with them.
  "src/modules/party/party-divergence.service.ts",
  "src/modules/party/party-legacy-clients.ts",
  "src/modules/party/party-legacy-contacts.ts",
  "src/modules/party/party-legacy-leads.ts",
  "src/modules/party/party-legacy-mirror.spec.ts",
  "src/modules/party/party-legacy-seam.ts",
  "src/modules/party/party-legacy-writer.db.spec.ts",
  "src/modules/party/party-legacy-writer.spec.ts",
  "src/modules/party/party-legacy-writer.ts",
  "src/modules/party/party-mirror-fields.ts",
  "src/modules/platform/platform.service.ts",
  "src/modules/sales/sales-analytics.service.ts",
  "src/modules/search/search.service.ts",
  "src/modules/surveys/survey-lead-automation.service.ts",
  ];

  /** Import of the Drizzle table symbol, which is how a read actually begins. */
  const LEGACY_IMPORT = new RegExp(
    String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]*(?:db/schema|schema/crm)[^'"]*)['"]`,
    "gs",
  );
  const LEGACY_TABLES = new Set(["leads", "clients", "contacts"]);

  function readersInTree(): string[] {
    /*
     * Tracked files plus untracked ones git would accept, which is not the same
     * as "tracked". A new call site is a new *file* as often as it is a new line,
     * and a tracked-only scan cannot see one until it is committed -- by which
     * point the ratchet reports it as a regression instead of preventing it. The
     * exclusions keep build artefacts and ignored scratch out.
     */
    const tracked = execSync(
      "git ls-files --cached --others --exclude-standard 'src/**/*.ts'",
      { encoding: "utf8" },
    )
      .split("\n")
      // Tracked-but-deleted paths are still listed, and another session is
      // mid-refactor in this tree, so existence is checked rather than assumed.
      .filter((f) => f && !f.includes("db/schema/") && existsSync(f));

    return tracked.filter((file) => {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(LEGACY_IMPORT))
        for (const raw of match[1]!.split(","))
          if (LEGACY_TABLES.has(raw.split(" as ")[0]!.trim())) return true;
      return false;
    });
  }

  it("has no reader that is not already known", () => {
    const known = new Set(KNOWN_READERS);
    const added = readersInTree().filter((f) => !known.has(f));

    // A new entry here means a call site was added to a table this phase is
    // removing. Migrate it onto the Party seam (`party-legacy-seam.ts`) rather
    // than adding it to the list above.
    expect(added).toEqual([]);
  });

  it("keeps the list honest as batches land", () => {
    const actual = new Set(readersInTree());
    const departed = KNOWN_READERS.filter((f) => !actual.has(f));

    // These no longer read a legacy table — delete them from KNOWN_READERS. The
    // list is a debt register, and a debt register nobody pays down is a lie.
    expect(departed).toEqual([]);
  });

  it("reports how much of the migration is left", () => {
    const remaining = readersInTree().length;
    // Not an assertion about progress — a number that shows up in the run, so
    // the phase's central task has a visible size rather than a vibe.
    expect(remaining).toBeLessThanOrEqual(KNOWN_READERS.length);
  });
});
