import {
  DECLARED_DISPOSITIONS,
  dispositionOf,
  emailColumnsOf,
  mayFileAsComplete,
  SUBJECT_REQUEST_PLAN,
  undeclaredTablesHoldingData,
  type TableOutcome,
} from "./subject-request-plan";
import {
  PERSONAL_DATA_TABLES,
  PERSONAL_DATA_TABLE_NAMES,
} from "../personal-data-registry";
import type { SubjectRequestResult } from "./subject-request";

/**
 * The two properties this file exists to hold.
 *
 * That an erasure never quietly acts on a table nobody decided about, and that
 * it never reports itself complete while such a table holds the subject's data.
 * Both are easy to break by accident — the first by defaulting `undeclared` to
 * `erase` "for coverage", the second by anding the table check into the region
 * check and losing it in a refactor — and neither breaks anything visible when
 * it goes. What it looks like from outside is a green erasure.
 */

const AT = "2026-08-26T12:00:00.000Z";

function outcome(over: Partial<TableOutcome> & { table: string }): TableOutcome {
  return {
    disposition: "undeclared",
    status: "scanned",
    rowsMatched: 0,
    rowsErased: 0,
    ...over,
  };
}

function completedRun(regions: readonly string[]): SubjectRequestResult {
  return {
    kind: "erasure",
    subjectEmail: "subject@example.test",
    regions: regions.map((region) => ({
      region,
      status: "completed" as const,
      recordsAffected: 1,
      at: AT,
    })),
    complete: true,
    totalRecordsAffected: regions.length,
    backupsExpireBy: null,
  };
}

describe("declared dispositions", () => {
  it("declares nothing for a table the registry does not inventory", () => {
    const unknown = DECLARED_DISPOSITIONS.map((entry) => entry.table).filter(
      (table) => !PERSONAL_DATA_TABLE_NAMES.has(table),
    );

    // A disposition for a table that does not hold personal data -- or no longer
    // exists -- is an instruction that will never fire, sitting in a file whose
    // whole value is that every line in it was decided on purpose.
    expect(unknown).toEqual([]);
  });

  it("makes every declaration argue for itself", () => {
    const unargued = DECLARED_DISPOSITIONS.filter((entry) => entry.why.trim().length < 60).map(
      (entry) => entry.table,
    );

    // Same reason `cross-region.spec.ts` checks the same thing: a list of
    // one-word justifications is a list nobody reads, and this one is the
    // difference between a compliance control and a document that resembles one.
    expect(unargued).toEqual([]);
  });

  it("stays far smaller than the registry it sits beside", () => {
    // The registry inventories every table holding personal data and refuses to
    // dispose of any of them, because "inventing [that many] of those would
    // produce a document that looks like a compliance control and is not one".
    // This file only escapes that objection while it stays short. If it ever
    // approaches the registry's size, somebody has started guessing, and that is
    // the failure -- not a missing feature.
    expect(DECLARED_DISPOSITIONS.length).toBeLessThanOrEqual(24);

    // A ratio rather than a floor under the registry's own count. That floor was
    // 100 and it passed only because the registry was inflated: its generator
    // bled columns between adjacent tables, so 81 of 149 entries described a
    // table holding none of what was claimed. Correcting it to 68 broke this
    // assertion, which had quietly become a lock on the wrong number. What the
    // test is actually about is the gap between an inventory and a disposition,
    // and that survives the registry being any honest size.
    expect(DECLARED_DISPOSITIONS.length * 3).toBeLessThan(PERSONAL_DATA_TABLES.length);
  });

  it("never disposes of the record a regulator reads", () => {
    // `subject_requests` is on GLOBAL_PERSONAL_DATA_TABLES on purpose: the
    // erasure record keeps the subject's email forever. An erasure that deleted
    // it would delete the row being written by the run doing the deleting, and
    // leave no evidence that any of it happened.
    expect(dispositionOf("subject_requests")).toBe("retain");
  });

  it("never deletes a suppression, because absence means we may mail them again", () => {
    expect(dispositionOf("email_suppressions")).toBe("retain");
    expect(dispositionOf("crm_suppression_hashes")).toBe("retain");
  });

  it("answers undeclared for everything nobody has decided", () => {
    // Not "erase by default", which is the mistake this whole design exists to
    // refuse, and not an exception either -- an unknown table has to have an
    // answer the executor can act on, and that answer is "leave it alone and
    // say so".
    expect(dispositionOf("candidates")).toBe("undeclared");
    expect(dispositionOf("a_table_that_does_not_exist")).toBe("undeclared");
  });
});

describe("locating the subject by address", () => {
  it("ignores the columns that merely contain the word email", () => {
    // The registry lists these on dozens of tables because the scan that
    // generated it matched a substring. `email_enabled` is a boolean;
    // `lower(email_enabled) = 'a@b.test'` raises 42883 and fails the whole
    // region, and `email_sent_at` is a timestamp that can never equal an address.
    expect(
      emailColumnsOf({
        table: "audit_logs",
        columns: ["email_enabled", "ip_address", "user_agent", "whatsapp_enabled"],
        scope: "org_id",
      }),
    ).toEqual([]);

    expect(
      emailColumnsOf({
        table: "onboarding_documents",
        columns: ["email", "email_sent_at", "email_status"],
        scope: "org_id",
      }),
    ).toEqual(["email"]);
  });

  it("takes every column that ends in an address, whatever it is prefixed with", () => {
    expect(
      emailColumnsOf({
        table: "hr_people",
        columns: ["address", "first_name", "personal_email", "phone", "work_email"],
        scope: "org_id",
      }),
    ).toEqual(["personal_email", "work_email"]);
  });

  it("takes the two address columns that do not end in email", () => {
    // `mailbox_address` and `recipient_address` are listed by hand. Without
    // them, `crm_mailbox_sync`, `notification_deliveries` and
    // `notification_events` report as unsearchable and the subject's connected
    // mailbox is never found.
    expect(
      emailColumnsOf({
        table: "crm_mailbox_sync",
        columns: ["mailbox_address"],
        scope: "organization_id",
      }),
    ).toEqual(["mailbox_address"]);
  });

  it("plans every registry table, including the ones it cannot search", () => {
    expect(SUBJECT_REQUEST_PLAN.map((plan) => plan.table)).toEqual(
      PERSONAL_DATA_TABLES.map((entry) => entry.table),
    );

    // `login_history` holds an IP address and a user agent and no address at
    // all. Dropping it from the plan would make "we cannot find you here"
    // indistinguishable from "you are not here" -- and the second is a claim
    // nobody checked.
    const loginHistory = SUBJECT_REQUEST_PLAN.find((plan) => plan.table === "login_history");
    expect(loginHistory?.emailColumns).toEqual([]);
  });
});

describe("the gap an erasure must not hide", () => {
  it("names only the undeclared tables that actually held a row", () => {
    const named = undeclaredTablesHoldingData([
      outcome({ table: "candidates", rowsMatched: 3 }),
      outcome({ table: "crm_people", rowsMatched: 0 }),
      outcome({ table: "platform_waitlist", disposition: "erase", rowsMatched: 1, rowsErased: 1 }),
      outcome({ table: "invoices", disposition: "retain", rowsMatched: 9 }),
    ]);

    // An undeclared table holding nothing is not a gap -- there is nothing there
    // to decide about. A declared one is not a gap either, whichever way it was
    // decided. Exactly one of these four is.
    expect(named).toEqual(["candidates"]);
  });

  it("names a table once however many regions it was found in", () => {
    const named = undeclaredTablesHoldingData([
      outcome({ table: "candidates", rowsMatched: 3 }),
      outcome({ table: "candidates", rowsMatched: 1 }),
      outcome({ table: "crm_people", rowsMatched: 2 }),
    ]);

    expect(named).toEqual(["candidates", "crm_people"]);
  });
});

describe("mayFileAsComplete", () => {
  it("refuses an erasure that left the subject in an undeclared table", () => {
    const may = mayFileAsComplete("erasure", completedRun(["india", "eu"]), ["india", "eu"], [
      outcome({ table: "platform_waitlist", disposition: "erase", rowsMatched: 1, rowsErased: 1 }),
      outcome({ table: "candidates", rowsMatched: 4 }),
    ]);

    // Every region was visited and every region succeeded, so `complete` is
    // true. Four of the subject's rows are still in `candidates` because nobody
    // has ever decided what happens to them. This is the case the whole file is
    // for: a run that looks finished from every angle except the one that
    // matters.
    expect(may).toBe(false);
  });

  it("allows an erasure where every table holding the subject was decided", () => {
    const may = mayFileAsComplete("erasure", completedRun(["india", "eu"]), ["india", "eu"], [
      outcome({ table: "platform_waitlist", disposition: "erase", rowsMatched: 2, rowsErased: 2 }),
      outcome({ table: "invoices", disposition: "retain", rowsMatched: 7 }),
      outcome({ table: "candidates", rowsMatched: 0 }),
    ]);

    // A retained table is decided, not left behind: the answer is "the law says
    // this stays", and 7 invoice rows surviving is the correct outcome.
    expect(may).toBe(true);
  });

  it("holds an export to the region rule alone", () => {
    const result = { ...completedRun(["india", "eu"]), kind: "export" as const };
    const undecided = [outcome({ table: "candidates", rowsMatched: 4 })];

    // Nothing is decided per table when the terminal action is "hand it over" --
    // the same 4 rows that block an erasure are simply 4 rows that got exported.
    expect(mayFileAsComplete("export", result, ["india", "eu"], undecided)).toBe(true);
    expect(mayFileAsComplete("erasure", result, ["india", "eu"], undecided)).toBe(false);
  });

  it("refuses either kind when a table hit the export cap", () => {
    const result = { ...completedRun(["india"]), kind: "export" as const };

    // A capped table is data we hold and did not hand over. Reporting that as a
    // complete export is the same lie as reporting a skipped table as erased.
    expect(
      mayFileAsComplete("export", result, ["india"], [
        outcome({ table: "candidates", rowsMatched: 5000, truncated: true }),
      ]),
    ).toBe(false);
  });

  it("refuses when a configured region was never visited, whatever the tables say", () => {
    const may = mayFileAsComplete("erasure", completedRun(["india"]), ["india", "eu"], [
      outcome({ table: "platform_waitlist", disposition: "erase", rowsMatched: 1, rowsErased: 1 }),
    ]);

    // Delegated to `mayReportComplete`, and asserted here so the table layer can
    // never be refactored into replacing the region layer instead of adding to
    // it. Every table was decided; the EU copy was never looked at.
    expect(may).toBe(false);
  });

  it("refuses when a region failed, even with nothing undeclared", () => {
    const result: SubjectRequestResult = {
      ...completedRun(["india", "eu"]),
      regions: [
        { region: "india", status: "completed", recordsAffected: 1, at: AT },
        { region: "eu", status: "failed", recordsAffected: 0, at: AT, error: "timeout" },
      ],
      complete: false,
    };

    expect(mayFileAsComplete("erasure", result, ["india", "eu"], [])).toBe(false);
  });
});
