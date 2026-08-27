import type { Requester } from "../query/query-compiler";
import { QueryDescriptionError } from "../query/query-errors";
import {
  assertSegmentable,
  compileMembership,
  compileSize,
  driftedTooFar,
  readyToSend,
  SEGMENTABLE_ENTITIES,
  SEGMENT_REVIEW_THRESHOLD,
  type Segment,
} from "./segment";

const ACME: Requester = { orgId: "org-acme", userId: "user-1", scope: "all" };
const OTHER: Requester = { orgId: "org-other", userId: "user-9", scope: "all" };

const SEGMENT: Segment = {
  segmentId: "seg-1",
  orgId: "org-acme",
  name: "Customers added this year",
  entity: "parties",
  description: {
    entity: "parties",
    filters: [
      { field: "partyType", operator: "eq", value: "CUSTOMER" },
      { field: "createdAt", operator: "gte", value: "2026-01-01" },
    ],
    select: ["id", "name"],
    limit: 100,
  },
  evaluation: { mode: "live" },
};

describe("a segment is a query description, not a second way to say which records", () => {
  it("is expressible over party, subject and activity", () => {
    // The first criterion, and it is only true because those three are entities
    // in the same graph reports use.
    expect([...SEGMENTABLE_ENTITIES]).toEqual(["parties", "subjects", "activities"]);
    for (const entity of SEGMENTABLE_ENTITIES)
      expect(() => assertSegmentable({ entity })).not.toThrow();
  });

  it("refuses an entity whose rows are not things you can reach", () => {
    /*
      A deal is not a recipient. Segmenting on deals and then mailing "the
      segment" means mailing whoever is attached to each one, so a person with
      four open deals gets four copies of the campaign.
    */
    expect(() => assertSegmentable({ entity: "deals" })).toThrow(QueryDescriptionError);
    expect(() => assertSegmentable({ entity: "deals" })).toThrow(/not one/);
  });

  it("gets its tenancy from the compiler, exactly as a report does", () => {
    const membership = compileMembership(SEGMENT, ACME);
    expect(membership.text).toContain('"t0"."organization_id" = $1');
    expect(membership.params[0]).toBe("org-acme");

    // Same segment, different tenant, different parameter — nothing about the
    // segment carries an organisation.
    const elsewhere = compileMembership(SEGMENT, OTHER);
    expect(elsewhere.text).toBe(membership.text);
    expect(elsewhere.params[0]).toBe("org-other");
  });

  it("honours the requester's scope, so membership is not wider than the person", () => {
    const narrow = compileMembership(
      { ...SEGMENT, entity: "activities", description: { ...SEGMENT.description, entity: "activities", filters: [], select: ["id"] } },
      { ...ACME, scope: "own" },
    );
    expect(narrow.text).toContain('"t0"."actor_user_id" = $2');
    expect(narrow.params).toContain("user-1");
  });

  it("excludes deleted records from membership, like every other query", () => {
    // A segment that mails deleted contacts is the worst version of this bug,
    // because the send is visible to the recipient.
    expect(compileMembership(SEGMENT, ACME).text).toContain('"t0"."deleted_at" IS NULL');
  });

  it("has nowhere to write a predicate of its own", () => {
    const smuggled: Segment = {
      ...SEGMENT,
      description: {
        ...SEGMENT.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ where: "1=1", orgId: "org-other" } as any),
      },
    };
    const compiled = compileMembership(smuggled, ACME);
    expect(compiled.text).not.toContain("1=1");
    expect(compiled.params).not.toContain("org-other");
  });
});

describe("its size is visible before anything is sent", () => {
  it("counts through the same description the members come from", () => {
    /*
      The fourth criterion, and the reason it is derived rather than written
      separately: a count from a different query counts a different thing, and
      the number a person approves would not be the number that receives the
      mail.
    */
    const size = compileSize(SEGMENT, ACME);
    expect(size.text).toContain("COUNT(*)");
    // Both carry the same filters, in the same order, with the same parameters
    // after the tenancy one.
    const members = compileMembership(SEGMENT, ACME);
    expect(size.params.slice(0, 3)).toEqual(members.params.slice(0, 3));
    expect(size.text).not.toContain("GROUP BY");
  });

  it("does not report the page size as the segment size", () => {
    /*
      The most reassuring possible wrong answer to "how many people am I about
      to email". The description is limited to a hundred; the count must not be.
    */
    const capped: Segment = { ...SEGMENT, description: { ...SEGMENT.description, limit: 5 } };
    const size = compileSize(capped, ACME);
    expect(size.params).not.toContain(5);
    // ...and it does not inherit the compiler's own default page either, which
    // would read to the next person as "this segment has a hundred members".
    expect(size.params).not.toContain(100);
    expect(size.params[size.params.length - 1]).toBe(1);
  });

  it("refuses to send to a segment that matches nobody", () => {
    // Sending to an empty segment "succeeds" and reaches no one, and the author
    // finds out weeks later.
    const verdict = readyToSend(0, true);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.why).toMatch(/matches nobody/);
  });

  it("makes somebody confirm an unexpectedly large segment", () => {
    const big = readyToSend(SEGMENT_REVIEW_THRESHOLD, false);
    expect(big.ok).toBe(false);
    expect(!big.ok && big.why).toContain(String(SEGMENT_REVIEW_THRESHOLD));

    // ...and lets them proceed once they have.
    expect(readyToSend(SEGMENT_REVIEW_THRESHOLD, true)).toEqual({
      ok: true,
      size: SEGMENT_REVIEW_THRESHOLD,
    });
  });

  it("lets an ordinary segment through without ceremony", () => {
    expect(readyToSend(120, false)).toEqual({ ok: true, size: 120 });
  });
});

describe("a segment re-evaluates unless somebody deliberately froze it", () => {
  it("defaults to live, so somebody who stops matching stops receiving", () => {
    expect(SEGMENT.evaluation.mode).toBe("live");
  });

  it("makes a snapshot state when it was taken and why", () => {
    /*
      The second criterion's word is "deliberately". A snapshot with no reason
      and no timestamp is indistinguishable from a live segment that quietly
      stopped updating — which is how a list built in March keeps mailing eleven
      people who have opted out since.
    */
    const frozen: Segment = {
      ...SEGMENT,
      evaluation: {
        mode: "snapshot",
        takenAt: new Date("2026-03-01T00:00:00.000Z"),
        because: "control arm of the March pricing test",
      },
    };
    expect(frozen.evaluation).toHaveProperty("takenAt");
    expect(frozen.evaluation).toHaveProperty("because");
  });

  it("stops a send whose audience moved materially since it was approved", () => {
    /*
      The cost of being live: the size approved and the size at send time can
      differ, and usually should. A ten per cent move is the segment working; a
      doubling is an import that landed in between, and nobody approved that.
    */
    expect(driftedTooFar(1000, 1050)).toBe(false);
    expect(driftedTooFar(1000, 950)).toBe(false);
    expect(driftedTooFar(1000, 2000)).toBe(true);
    expect(driftedTooFar(1000, 100)).toBe(true);
  });

  it("treats a segment that was empty and is not any more as a material change", () => {
    // Percentage drift is undefined from zero, and the honest reading is that
    // going from nobody to somebody is exactly the case a human should see.
    expect(driftedTooFar(0, 1)).toBe(true);
    expect(driftedTooFar(0, 0)).toBe(false);
  });
});
