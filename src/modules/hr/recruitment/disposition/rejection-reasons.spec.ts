import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideRejection,
  REJECTION_NOTE_MAX_LENGTH,
  REJECTION_REASONS,
  REJECTION_REASON_LABELS,
  type RejectionReason,
} from "./rejection-reasons";

const REPO_ROOT = resolve(__dirname, "../../../../..");

function allowed(input: Parameters<typeof decideRejection>[0]) {
  const decision = decideRejection(input);
  if (!decision.allowed) throw new Error(`expected a pass, got: ${decision.message}`);
  return decision;
}

function refused(input: Parameters<typeof decideRejection>[0]) {
  const decision = decideRejection(input);
  if (decision.allowed) throw new Error("expected a refusal");
  return decision;
}

describe("decideRejection — a reject must say why", () => {
  /**
   * The rule the whole module exists for. Before it, a reject was one drag: it
   * moved the stage, it could email the candidate, and it recorded nothing. A
   * default — "OTHER", or an empty string — would have satisfied the column and
   * left the pipeline exactly as uninformative as before, so the absent case
   * has to refuse rather than fill in.
   */
  it.each([[undefined], [null], [""], ["   "], ["\n\t"]])(
    "refuses a rejection whose reason is %p",
    (reason) => {
      expect(refused({ reason }).message).toContain("required");
    },
  );

  /**
   * OTHER is the escape hatch, and an unexplained escape hatch is where a
   * required field goes to die: one click and every rejection is "Other" again,
   * with the catalog back to meaning nothing. The note is what keeps OTHER more
   * expensive than picking the right code.
   */
  it.each([[undefined], [null], [""], ["  "], ["\n"]])(
    "refuses OTHER whose note is %p",
    (note) => {
      expect(refused({ reason: "OTHER", note }).message).toContain("Other");
    },
  );

  it("allows OTHER once it carries a note", () => {
    expect(allowed({ reason: "OTHER", note: "Role was re-scoped mid-loop." })).toEqual({
      allowed: true,
      reason: "OTHER",
      note: "Role was re-scoped mid-loop.",
    });
  });

  it("allows a catalog reason with no note", () => {
    expect(allowed({ reason: "NOTICE_PERIOD" })).toEqual({
      allowed: true,
      reason: "NOTICE_PERIOD",
      note: null,
    });
  });

  it.each(REJECTION_REASONS.filter((code) => code !== "OTHER"))(
    "allows %s without a note",
    (code) => {
      expect(allowed({ reason: code }).reason).toBe(code);
    },
  );

  /**
   * A note of spaces must not reach the column. Stored raw it satisfies "has a
   * note" for every later reader — a report, an export, the detail page — while
   * saying nothing, which is the one outcome the OTHER rule exists to prevent.
   */
  it("normalises a whitespace-only note on a real reason to null", () => {
    expect(allowed({ reason: "LOCATION", note: "   " }).note).toBeNull();
  });

  it("trims the note it hands back", () => {
    expect(allowed({ reason: "COMPENSATION", note: "  Expected 2x band.  " }).note).toBe(
      "Expected 2x band.",
    );
  });

  it("trims the reason before matching, so a padded code is still a code", () => {
    expect(allowed({ reason: "  SKILLS_MISMATCH  " }).reason).toBe("SKILLS_MISMATCH");
  });

  /**
   * The column is not a place to paste an interview transcript. Enforced here
   * as well as in the DTO because a caller that skips the DTO — a bulk action,
   * an import, a future internal caller — would otherwise write past the bound
   * the schema advertises.
   */
  it("refuses a note longer than the documented bound", () => {
    const note = "x".repeat(REJECTION_NOTE_MAX_LENGTH + 1);
    expect(refused({ reason: "OTHER", note }).message).toContain(String(REJECTION_NOTE_MAX_LENGTH));
    expect(allowed({ reason: "OTHER", note: "x".repeat(REJECTION_NOTE_MAX_LENGTH) }).note).toHaveLength(
      REJECTION_NOTE_MAX_LENGTH,
    );
  });
});

describe("the catalog is closed", () => {
  /**
   * The point of a code list is that it is a list. Free text produces "comp",
   * "CTC", "salary expectation" and "budget" for one fact and nothing
   * downstream can count them — which is the state this module replaced, so
   * accepting an unlisted string would quietly restore it.
   */
  it.each([
    ["NOT_A_FIT"],
    ["Not a fit"],
    ["skills_mismatch"],
    ["SKILLS MISMATCH"],
    ["SKILLS_MISMATCHED"],
    ["OTHERS"],
    ["__proto__"],
  ])("refuses %p, which is not in the catalog", (reason) => {
    expect(refused({ reason }).allowed).toBe(false);
  });

  /**
   * Pinned by value, not by shape. Codes are stored, so renaming one is a data
   * migration and adding one needs the CHECK constraint widened first —
   * editing this array alone must break a test rather than start writing values
   * the database will reject.
   */
  it("is exactly these eleven codes", () => {
    expect([...REJECTION_REASONS]).toEqual([
      "SKILLS_MISMATCH",
      "EXPERIENCE_MISMATCH",
      "COMPENSATION",
      "LOCATION",
      "NOTICE_PERIOD",
      "WITHDREW",
      "POSITION_CLOSED",
      "FAILED_ASSESSMENT",
      "BACKGROUND_CHECK",
      "DUPLICATE",
      "OTHER",
    ]);
  });

  it("has no duplicate codes", () => {
    expect(new Set(REJECTION_REASONS).size).toBe(REJECTION_REASONS.length);
  });

  /**
   * WITHDREW and POSITION_CLOSED are not judgements about the candidate: one
   * person walked away and one requisition closed. Merging either into a
   * skills or experience bucket would overstate how many people the team turned
   * down and would lose the fact that a withdrawn candidate is re-approachable.
   */
  it("keeps the dispositions that are not about the candidate", () => {
    expect(REJECTION_REASONS).toContain("WITHDREW");
    expect(REJECTION_REASONS).toContain("POSITION_CLOSED");
  });
});

describe("labels are display-only", () => {
  it("has a label for every code and no label for anything else", () => {
    expect(Object.keys(REJECTION_REASON_LABELS).sort()).toEqual([...REJECTION_REASONS].sort());
  });

  /**
   * The separation that makes a label safe to reword. If a label were ever
   * accepted as input, a team that renamed one would silently start writing a
   * second value for the same reason and every grouped report would split.
   */
  it("never accepts a label where a code belongs", () => {
    for (const label of Object.values(REJECTION_REASON_LABELS)) {
      expect(refused({ reason: label, note: "anything" }).allowed).toBe(false);
    }
  });

  it("gives every refusal a sentence that ends", () => {
    const refusals = [
      refused({}),
      refused({ reason: "NOPE" }),
      refused({ reason: "OTHER" }),
      refused({ reason: "OTHER", note: "x".repeat(REJECTION_NOTE_MAX_LENGTH + 1) }),
    ];
    for (const decision of refusals) expect(decision.message.endsWith(".")).toBe(true);
  });
});

/**
 * The catalog lives in three files — this module, migration 1187's CHECK
 * constraint and the Drizzle `$type` on `candidates` — because the schema does
 * not import from a feature module. Three hand-kept copies drift, and the drift
 * is invisible until a recruiter picks a new code and the insert is refused by
 * the database in production. These read the other two files and compare.
 */
describe("the catalog matches what the database and the schema allow", () => {
  function codesIn(text: string): string[] {
    return Array.from(text.matchAll(/["']([A-Z][A-Z_]+)["']/g), (m) => m[1] ?? "");
  }

  it("matches the CHECK constraint in migrations/1187_rejection_reason.sql", () => {
    const sql = readFileSync(resolve(REPO_ROOT, "migrations/1187_rejection_reason.sql"), "utf8");
    const clause = /chk_candidates_rejection_reason[\s\S]*?IN \(([^)]*)\)/.exec(sql)?.[1];
    /* Asserted before the comparison so a moved or renamed file fails loudly
       instead of comparing two empty lists and passing. */
    expect(clause).toBeDefined();
    expect(codesIn(clause ?? "")).toEqual([...REJECTION_REASONS]);
  });

  it("matches the $type union on candidates.rejectionReason", () => {
    const schema = readFileSync(
      resolve(REPO_ROOT, "src/db/schema/hr/hiring-candidates.ts"),
      "utf8",
    );
    const union = /text\("rejection_reason"\)\.\$type<([\s\S]*?)>\(\)/.exec(schema)?.[1];
    expect(union).toBeDefined();
    expect(codesIn(union ?? "")).toEqual([...REJECTION_REASONS]);
  });

  /**
   * The database also refuses OTHER without a note, so a write that bypassed
   * this module entirely still cannot create the row the rule forbids. The
   * application check is the good error message; the constraint is the floor.
   */
  it("keeps the OTHER-needs-a-note pairing in the migration too", () => {
    const sql = readFileSync(resolve(REPO_ROOT, "migrations/1187_rejection_reason.sql"), "utf8");
    expect(sql).toContain("chk_candidates_rejection_other_note");
    expect(sql).toMatch(/rejection_reason" IS DISTINCT FROM 'OTHER'/);
  });
});

/** A compile-time check that the exported type is the catalog and not `string`. */
const typeIsTheCatalog: RejectionReason = "DUPLICATE";
void typeIsTheCatalog;
