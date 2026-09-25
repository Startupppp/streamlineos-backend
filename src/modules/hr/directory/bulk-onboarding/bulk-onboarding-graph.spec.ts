import {
  findManagerCycles,
  managersFirst,
  type ManagerEdge,
} from "./bulk-onboarding-graph";

/**
 * HRMS-E2E-002b. QA's eight-row fixture named a manager and a member reporting
 * to that manager in the same file and produced Created 0, Failed 5: the
 * manager was only ever looked for among existing members, so a report pointed
 * at somebody two rows above who did not exist yet.
 */
describe("bulk onboarding reporting graph", () => {
  const edge = (row: number, email: string, managerEmail: string): ManagerEdge => ({
    row,
    email,
    managerEmail,
  });

  describe("cycles", () => {
    it("finds nothing in a chain that terminates", () => {
      expect(
        findManagerCycles([edge(3, "member@x.com", "lead@x.com"), edge(2, "lead@x.com", "owner@x.com")]),
      ).toEqual([]);
    });

    it("reports both rows of a two-row loop", () => {
      const found = findManagerCycles([
        edge(2, "a@x.com", "b@x.com"),
        edge(3, "b@x.com", "a@x.com"),
      ]);
      expect(found.map((finding) => finding.row)).toEqual([2, 3]);
    });

    it("reports a three-row loop and names the chain", () => {
      const found = findManagerCycles([
        edge(2, "a@x.com", "b@x.com"),
        edge(3, "b@x.com", "c@x.com"),
        edge(4, "c@x.com", "a@x.com"),
      ]);
      expect(found.map((finding) => finding.row)).toEqual([2, 3, 4]);
      expect(found[0]?.chain.length).toBeGreaterThanOrEqual(3);
    });

    it("finds a row that reports to itself", () => {
      expect(findManagerCycles([edge(5, "a@x.com", "a@x.com")]).map((f) => f.row)).toEqual([5]);
    });

    it("leaves a clean branch alone while reporting the loop beside it", () => {
      const found = findManagerCycles([
        edge(2, "a@x.com", "b@x.com"),
        edge(3, "b@x.com", "a@x.com"),
        edge(4, "clean@x.com", "owner@x.com"),
      ]);
      expect(found.map((finding) => finding.row)).toEqual([2, 3]);
    });
  });

  describe("ordering", () => {
    it("puts a manager before the people reporting to them", () => {
      const order = managersFirst(
        ["member@x.com", "lead@x.com", "admin@x.com"],
        [edge(3, "member@x.com", "lead@x.com"), edge(2, "lead@x.com", "admin@x.com")],
      );
      expect(order.indexOf("admin@x.com")).toBeLessThan(order.indexOf("lead@x.com"));
      expect(order.indexOf("lead@x.com")).toBeLessThan(order.indexOf("member@x.com"));
    });

    it("keeps every email exactly once", () => {
      const emails = ["a@x.com", "b@x.com", "c@x.com"];
      const order = managersFirst(emails, [
        edge(1, "a@x.com", "b@x.com"),
        edge(2, "b@x.com", "c@x.com"),
      ]);
      expect([...order].sort()).toEqual([...emails].sort());
    });

    it("does not hang on a loop", () => {
      const order = managersFirst(
        ["a@x.com", "b@x.com"],
        [edge(1, "a@x.com", "b@x.com"), edge(2, "b@x.com", "a@x.com")],
      );
      expect(order).toHaveLength(2);
    });

    it("ignores a manager who is not in this file, because they already exist", () => {
      const order = managersFirst(["member@x.com"], [edge(1, "member@x.com", "existing@x.com")]);
      expect(order).toEqual(["member@x.com"]);
    });
  });
});
