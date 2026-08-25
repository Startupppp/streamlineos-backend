import type { SubjectFieldDefinition } from "../../db/schema/party/subjects";
import {
  deriveTitle,
  normaliseSubjectValues,
  validateFieldDefinitions,
  validateSubjectValues,
} from "./subject-values";

/**
 * The validation exercise ticket 07 asks for: two genuinely different industry
 * shapes, modelled end to end against the real declaration and value rules.
 *
 * An estate agency's subject is an ASSET that outlives every party attached to
 * it, and the parties hold opposing sides of one trade. A recruiter's subject is
 * a PERSON, and the parties around them are employers competing for them. If one
 * fixed schema can serve both without an `industry` column appearing anywhere,
 * the model holds. Where it strains is recorded in the ticket's notes, and each
 * strain has a test here so it is a known boundary rather than a surprise.
 */

const PROPERTY_FIELDS: SubjectFieldDefinition[] = [
  { name: "address", label: "Address", kind: "text", required: true },
  { name: "postcode", label: "Postcode", kind: "text", required: true },
  {
    name: "tenure",
    label: "Tenure",
    kind: "select",
    options: [
      { value: "FREEHOLD", label: "Freehold", tone: "success" },
      { value: "LEASEHOLD", label: "Leasehold", tone: "info" },
    ],
  },
  { name: "bedrooms", label: "Bedrooms", kind: "number" },
  { name: "askingPrice", label: "Asking price", kind: "money" },
  { name: "listedOn", label: "Listed on", kind: "date" },
];

const CANDIDATE_FIELDS: SubjectFieldDefinition[] = [
  { name: "fullName", label: "Full name", kind: "text", required: true },
  { name: "email", label: "Email", kind: "email", required: true },
  { name: "phone", label: "Phone", kind: "phone" },
  {
    name: "discipline",
    label: "Discipline",
    kind: "select",
    options: [
      { value: "ENGINEERING", label: "Engineering" },
      { value: "DESIGN", label: "Design" },
    ],
  },
  { name: "yearsExperience", label: "Years of experience", kind: "number" },
  { name: "availableFrom", label: "Available from", kind: "date" },
];

describe("one schema, two industries", () => {
  it("accepts both declarations", () => {
    expect(validateFieldDefinitions(PROPERTY_FIELDS, "address")).toEqual([]);
    expect(validateFieldDefinitions(CANDIDATE_FIELDS, "fullName")).toEqual([]);
  });

  it("accepts a real record of each", () => {
    expect(
      validateSubjectValues(PROPERTY_FIELDS, {
        address: "14 Bridge Street",
        postcode: "BS1 4ND",
        tenure: "FREEHOLD",
        bedrooms: 3,
        askingPrice: 42500000,
        listedOn: "2026-08-02",
      }),
    ).toEqual([]);

    expect(
      validateSubjectValues(CANDIDATE_FIELDS, {
        fullName: "Priya Raman",
        email: "priya@example.com",
        phone: "+44 7700 900123",
        discipline: "ENGINEERING",
        yearsExperience: 8,
        availableFrom: "2026-09-15",
      }),
    ).toEqual([]);
  });

  it("titles each record by the field its own industry leads with", () => {
    expect(deriveTitle("address", { address: "14 Bridge Street" }, "Untitled")).toBe(
      "14 Bridge Street",
    );
    expect(deriveTitle("fullName", { fullName: "Priya Raman" }, "Untitled")).toBe("Priya Raman");
  });

  it("rejects the other industry's vocabulary rather than storing it", () => {
    const problems = validateSubjectValues(PROPERTY_FIELDS, {
      address: "14 Bridge Street",
      postcode: "BS1 4ND",
      yearsExperience: 8,
    });

    expect(problems).toEqual([
      { field: "yearsExperience", message: '"yearsExperience" is not a field on this type' },
    ]);
  });

  /**
   * STRAIN 1 — money is a declared number, so its unit is a convention.
   *
   * The platform stores money as integer cents, but a tenant declaring a `money`
   * field is trusted to mean the same thing. Nothing in the declaration says
   * which currency or which scale, so an asking price of 425000 is ambiguous
   * between four hundred pounds and four hundred thousand. It validates either
   * way, which is exactly the problem.
   */
  it("cannot tell a mis-scaled amount from a correct one", () => {
    expect(validateSubjectValues(PROPERTY_FIELDS, {
      address: "14 Bridge Street",
      postcode: "BS1 4ND",
      askingPrice: 425,
    })).toEqual([]);

    expect(validateSubjectValues(PROPERTY_FIELDS, {
      address: "14 Bridge Street",
      postcode: "BS1 4ND",
      askingPrice: 42500000,
    })).toEqual([]);
  });

  /**
   * STRAIN 2 — a subject holds no lifecycle of its own.
   *
   * `status` is one free-text column. An estate agency's property moves
   * Available → Under offer → Exchanged → Completed, and a recruiter's candidate
   * moves Sourced → Screened → Submitted → Placed. Neither transition is
   * constrained, nothing records who moved it or when, and no declaration can
   * express the allowed moves. That is ticket 08's stage machinery, and until it
   * exists a subject's status is a label, not a state.
   */
  it("accepts any status transition, because it models none", () => {
    const withStatus: SubjectFieldDefinition[] = [
      ...PROPERTY_FIELDS,
      {
        name: "saleStage",
        label: "Sale stage",
        kind: "select",
        options: [
          { value: "AVAILABLE", label: "Available" },
          { value: "COMPLETED", label: "Completed" },
        ],
      },
    ];

    // Completed straight back to Available, with nothing to object.
    expect(
      validateSubjectValues(withStatus, {
        address: "14 Bridge Street",
        postcode: "BS1 4ND",
        saleStage: "AVAILABLE",
      }),
    ).toEqual([]);
  });

  /**
   * STRAIN 3 — a candidate is a person, and this is not the person model.
   *
   * The platform's canonical human is `organization_people`, and its canonical
   * external human is a party. A recruiter's candidate is a third, and nothing
   * reconciles it with either — the same person applying twice through two
   * agencies is two subjects with no duplicate detection, while the party model
   * has had exactly that since ticket 06. It is the problem the PRD opens with,
   * reappearing one level down.
   */
  it("has no notion that two candidate records may be the same human", () => {
    const first = { fullName: "Priya Raman", email: "priya@example.com" };
    const second = { fullName: "Priya Raman", email: "priya@example.com" };

    expect(validateSubjectValues(CANDIDATE_FIELDS, first)).toEqual([]);
    expect(validateSubjectValues(CANDIDATE_FIELDS, second)).toEqual([]);
    expect(normaliseSubjectValues(CANDIDATE_FIELDS, first)).toEqual(
      normaliseSubjectValues(CANDIDATE_FIELDS, second),
    );
  });

  /**
   * STRAIN 4 — a declaration change is not a migration, so old records drift.
   *
   * A tenant adding a required field leaves every existing record failing
   * validation on its next edit. Nothing backfills, nothing warns at declaration
   * time, and the failure surfaces to whoever next opens an old record rather
   * than to the administrator who caused it.
   */
  it("leaves existing records invalid when a required field is added later", () => {
    const stored = { fullName: "Priya Raman", email: "priya@example.com" };

    const tightened: SubjectFieldDefinition[] = [
      ...CANDIDATE_FIELDS,
      { name: "rightToWork", label: "Right to work", kind: "text", required: true },
    ];

    expect(validateSubjectValues(CANDIDATE_FIELDS, stored)).toEqual([]);
    expect(validateSubjectValues(tightened, stored)).toEqual([
      { field: "rightToWork", message: "Right to work is required" },
    ]);
  });

  /**
   * STRAIN 5 — removing a field silently discards its stored values.
   *
   * Normalisation keeps only declared fields, so a tenant who deletes a field
   * from a declaration loses that column's data on every record's next write,
   * with no warning and nothing to restore from.
   */
  it("drops the values of a field a tenant removed from the declaration", () => {
    const stored = {
      address: "14 Bridge Street",
      postcode: "BS1 4ND",
      bedrooms: 3,
    };

    const narrowed = PROPERTY_FIELDS.filter((field) => field.name !== "bedrooms");

    expect(normaliseSubjectValues(narrowed, stored)).toEqual({
      address: "14 Bridge Street",
      postcode: "BS1 4ND",
    });
  });
});
