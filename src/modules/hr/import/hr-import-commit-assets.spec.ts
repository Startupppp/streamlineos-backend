/**
 * V-080 and V-082, at the asset write itself.
 *
 * (a) The insert stored the RAW serial cell while the re-import lookup matched
 *     on `upper(trim(serial))`. So an estate could hold `qa-sn-0001` and
 *     `QA-SN-0001` as one asset whose stored value agreed with neither the match
 *     key nor the other rows — and every raw reader (the assets list, the CSV
 *     export, a search) saw the inconsistency.
 * (b) An `assignedToEmail` naming nobody left `assignedTo` NULL and reported the
 *     row as imported: a silent drop of the one column an operator checks.
 * (c) `status` defaulted to AVAILABLE even on a row that named an assignee,
 *     which is exactly why the Assigned tile disagreed with the rows under it.
 *
 * The assertions are on the VALUES handed to the insert, because that is where
 * all three defects live.
 */
import type { Db } from "../../../db/drizzle.module";
import { assets } from "../../../db/schema";
import { HrImportCommitService } from "./hr-import-commit.service";
import { importContext, stubAdmission, stubPersonEmployment } from "./import-commit-test-harness";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const ORG = "org-assets";

/**
 * A transaction double that records what the insert was given. `selectRows`
 * answers the assignee lookup; an empty array is "this org has nobody by that
 * email", which is the V-080b case.
 */
function fakeTx(selectRows: unknown[]) {
  const inserted: Array<Record<string, unknown>> = [];
  const select = () => {
    let table: unknown;
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(table === assets ? [] : selectRows).then(resolve),
    };
    for (const method of ["where", "orderBy", "limit", "innerJoin", "leftJoin"]) {
      builder[method] = () => builder;
    }
    builder["from"] = (t: unknown) => {
      table = t;
      return builder;
    };
    return builder;
  };
  const tx = {
    select,
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: () => Promise.resolve([{ id: 101 }]) };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  };
  return { tx: tx as unknown as Tx, inserted };
}

function service() {
  return new HrImportCommitService(stubAdmission(), stubPersonEmployment());
}

describe("HR asset import commit", () => {
  it("stores the normalized serial, not the raw cell", async () => {
    const { tx, inserted } = fakeTx([]);
    await service().commitRow(tx, importContext(ORG), "assets", {
      name: "QA Laptop",
      type: "LAPTOP",
      serialNumber: "  qa-sn-0001 ",
    });

    // The match key is `upper(trim(...))`, so that is what the row must carry.
    expect(inserted[0]?.["serialNumber"]).toBe("QA-SN-0001");
    expect(inserted[0]?.["serialNumber"]).not.toBe("  qa-sn-0001 ");
  });

  it("stores null rather than an empty serial", async () => {
    const { tx, inserted } = fakeTx([]);
    await service().commitRow(tx, importContext(ORG), "assets", {
      name: "QA Monitor",
      type: "MONITOR",
      serialNumber: "   ",
    });
    expect(inserted[0]?.["serialNumber"]).toBeNull();
  });

  it("fails the row when the assignee email names nobody in the org", async () => {
    const { tx, inserted } = fakeTx([]);
    await expect(
      service().commitRow(tx, importContext(ORG), "assets", {
        name: "QA Laptop",
        type: "LAPTOP",
        serialNumber: "QA-SN-0009",
        assignedToEmail: "ghost@example.test",
      }),
    ).rejects.toThrow("No user found for email ghost@example.test");
    // The asset must not be written unassigned and reported as imported.
    expect(inserted).toHaveLength(0);
  });

  it("marks an asset the file assigns as ASSIGNED unless the file says otherwise", async () => {
    const { tx, inserted } = fakeTx([{ userId: "user-1" }]);
    await service().commitRow(tx, importContext(ORG), "assets", {
      name: "QA Laptop",
      type: "LAPTOP",
      serialNumber: "QA-SN-0010",
      assignedToEmail: "known@example.test",
    });
    expect(inserted[0]?.["assignedTo"]).toBe("user-1");
    expect(inserted[0]?.["status"]).toBe("ASSIGNED");

    // Positive control: an unassigned row is still AVAILABLE, and a stated
    // status still wins over both.
    const unassigned = fakeTx([]);
    await service().commitRow(unassigned.tx, importContext(ORG), "assets", {
      name: "QA Spare",
      type: "LAPTOP",
      serialNumber: "QA-SN-0011",
    });
    expect(unassigned.inserted[0]?.["status"]).toBe("AVAILABLE");

    const stated = fakeTx([{ userId: "user-1" }]);
    await service().commitRow(stated.tx, importContext(ORG), "assets", {
      name: "QA Broken",
      type: "LAPTOP",
      serialNumber: "QA-SN-0012",
      assignedToEmail: "known@example.test",
      status: "MAINTENANCE",
    });
    expect(stated.inserted[0]?.["status"]).toBe("MAINTENANCE");
  });

  it("uses the id the preflight resolved instead of reading the person again", async () => {
    // The person lookup is wired to return nothing: if the commit still read
    // it, the row would fail.
    const { tx, inserted } = fakeTx([]);
    await service().commitRow(tx, importContext(ORG), "assets", {
      name: "QA Laptop",
      type: "LAPTOP",
      serialNumber: "QA-SN-0013",
      assignedToEmail: "known@example.test",
      resolvedUserId: "user-preflight",
    });
    expect(inserted[0]?.["assignedTo"]).toBe("user-preflight");
  });
});
