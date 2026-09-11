import { HrEmploymentsService } from "../hr-employments.service";

/**
 * `hr_employments.is_primary` defaults to true and `create` never overrode it,
 * so creating a second employment for a person who already had one produced two
 * live primaries. The standard directory join (organization_members -> users ->
 * live hr_people -> primary hr_employments) has no DISTINCT, so that employee
 * came back twice from GET /hr/employees, the keyset page was short by one real
 * employee, and every count()-based headcount was one too high.
 *
 * There is still no partial unique index enforcing this in the database — see
 * the report — so this service guard is the only thing standing between the API
 * and that state.
 */
const input = {
  personId: 42,
  employeeNumber: "EMP-1",
  lifecycleStatus: "ACTIVE" as const,
  workerType: "FULL_TIME" as const,
};

function makeDb(existingPrimary: { id: number } | undefined) {
  const inserted: Record<string, unknown>[] = [];
  let selectCall = 0;

  const selectChain = (rows: unknown[]) => {
    const node: Record<string, unknown> = {};
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) node[m] = () => node;
    node.limit = () => Promise.resolve(rows);
    return node;
  };

  // create() issues exactly three reads for this input, in order:
  //   1. assertReferences' personId probe  -> the person must exist
  //   2. the employee-number uniqueness probe -> free
  //   3. the existing-primary probe this guard added
  const responses: unknown[][] = [
    [{ id: input.personId }],
    [],
    existingPrimary ? [existingPrimary] : [],
  ];

  const db = {
    select: () => selectChain(responses[selectCall++] ?? []),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: () => Promise.resolve([{ id: 99, ...v }]) };
      },
    }),
  };

  return { db, inserted };
}

function makeService(existingPrimary: { id: number } | undefined) {
  const { db, inserted } = makeDb(existingPrimary);
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  // `as never` for Nest constructor injection is the idiom the sibling specs
  // use; check:type-assertions excludes the spec suite by design.
  const service = new HrEmploymentsService(db as never, audit as never);
  return { service, inserted };
}

describe("HrEmploymentsService.create — one live primary employment per person", () => {
  it("marks the first employment for a person primary", async () => {
    const { service, inserted } = makeService(undefined);
    await service.create("org1", "actor1", input as never);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ personId: 42, isPrimary: true });
  });

  it("does not mint a second primary when the person already has one", async () => {
    const { service, inserted } = makeService({ id: 7 });
    await service.create("org1", "actor1", input as never);
    expect(inserted).toHaveLength(1);
    // The second employment is still created — hr_employments is plural per
    // person by design — but it does not become a second primary.
    expect(inserted[0]).toMatchObject({ personId: 42, isPrimary: false });
  });

  it("always sets is_primary explicitly rather than leaning on the column default", async () => {
    for (const existing of [undefined, { id: 7 }]) {
      const { service, inserted } = makeService(existing);
      await service.create("org1", "actor1", input as never);
      expect(inserted[0]).toHaveProperty("isPrimary");
    }
  });
});
