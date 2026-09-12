import { auditableArguments, countResults } from "./crm-mcp.service";

/**
 * CRM-P1-04. What an MCP tool call leaves behind.
 *
 * `executeTool` wrote nothing at all: an agent could read a tenant's parties,
 * deals, activities and reports and leave no record that it had. These are the
 * two decisions in that audit entry that are easy to get wrong in opposite
 * directions — recording too little to reconstruct what happened, or recording
 * so much that the audit log becomes a second copy of the data it is auditing.
 */

describe("auditableArguments", () => {
  it("keeps the ids that make an entry reconstructable", () => {
    /** "read deal 412" is an audit entry; "read a deal" is not. */
    expect(auditableArguments({ dealId: 412, partyId: "9182" })).toEqual({
      dealId: 412,
      partyId: "9182",
    });
  });

  it("keeps a uuid whole", () => {
    const partyId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(auditableArguments({ partyId })).toEqual({ partyId });
  });

  it("redacts free text but records that it was there", () => {
    /**
     * The only string arguments these tools take other than ids are search
     * terms. Keeping them would accumulate a copy of everything anybody has
     * ever searched for inside the tenant's audit log — while dropping them
     * silently would hide that a search happened at all.
     */
    expect(auditableArguments({ search: "acme corp" })).toEqual({
      search: { redacted: true, length: 9 },
    });
  });

  it("keeps numbers and booleans, and an explicit null", () => {
    expect(auditableArguments({ limit: 20, includeClosed: false, stageId: null })).toEqual({
      limit: 20,
      includeClosed: false,
      stageId: null,
    });
  });

  it("drops nested objects rather than serialising them into the log", () => {
    expect(auditableArguments({ filter: { name: "acme" } })).toEqual({});
  });

  it("handles a call with no arguments", () => {
    expect(auditableArguments(undefined)).toEqual({});
  });
});

describe("countResults", () => {
  it("counts a bare array", () => {
    /**
     * The distinction worth auditing: "read one deal" and "read every deal you
     * have" are the same tool call.
     */
    expect(countResults([1, 2, 3])).toBe(3);
  });

  it("counts inside a paginated envelope", () => {
    expect(countResults({ data: [1, 2], total: 97 })).toBe(2);
    expect(countResults({ items: [1] })).toBe(1);
  });

  it("counts a single record as one", () => {
    expect(countResults({ dealId: 412, name: "Acme" })).toBe(1);
  });

  it("counts nothing as nothing", () => {
    /** A handler that matched no branch leaves `result` undefined. */
    expect(countResults(undefined)).toBe(0);
    expect(countResults(null)).toBe(0);
  });
});
