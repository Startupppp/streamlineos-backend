
/**
 * The reporting graph a single upload describes.
 *
 * `preloadManagerUserIdsByEmail` looks a manager up among the organisation's
 * *existing* active members, so a file that introduced a manager and someone
 * reporting to them failed the report with "Reporting manager … is not an active
 * member of this organization. Onboard the manager first." The manager was two
 * rows above. QA's eight-row fixture produced Created 0, Failed 5 for that
 * reason, and the workaround — upload the managers, wait, upload the rest — is
 * the thing a bulk upload exists to avoid.
 *
 * A manager may therefore also be another row of the same file. That turns the
 * upload into a graph, and a graph needs two things the flat pass never had: an
 * order to write the reporting lines in, and an answer for a file that points at
 * itself.
 */

export interface ManagerEdge {
  /** Row number (1-based, as the operator sees it) of the report. */
  row: number;
  email: string;
  /** Canonical email of the manager, when the manager is a row of this file. */
  managerEmail: string;
}

export interface CycleFinding {
  row: number;
  /** The chain, in the order it loops, for an error the operator can act on. */
  chain: string[];
}

/**
 * Rows whose reporting chain loops back on itself.
 *
 * Every row in a cycle is reported, not just the one that closed it: with A → B
 * → A there is no principled way to say which of the two is the mistake, and
 * failing one of them silently would leave the other pointing at a person who
 * was never created.
 */
export function findManagerCycles(edges: readonly ManagerEdge[]): CycleFinding[] {
  const managerOf = new Map<string, ManagerEdge>();
  for (const edge of edges) managerOf.set(edge.email, edge);

  const state = new Map<string, "visiting" | "settled">();
  const findings: CycleFinding[] = [];
  const reported = new Set<string>();

  for (const start of managerOf.keys()) {
    if (state.get(start) === "settled") continue;

    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: string | undefined = start;

    while (cursor !== undefined && state.get(cursor) !== "settled") {
      if (onPath.has(cursor)) {
        // Walked into a node already on this path: everything from its first
        // appearance onwards is the loop.
        const loop = path.slice(path.indexOf(cursor));
        for (const email of loop) {
          const edge = managerOf.get(email);
          if (!edge || reported.has(email)) continue;
          reported.add(email);
          findings.push({ row: edge.row, chain: [...loop, cursor] });
        }
        break;
      }
      onPath.add(cursor);
      path.push(cursor);
      state.set(cursor, "visiting");
      cursor = managerOf.get(cursor)?.managerEmail;
    }

    for (const email of path) state.set(email, "settled");
  }

  return findings.sort((a, b) => a.row - b.row);
}

/**
 * Emails ordered so that a manager is always written before anyone reporting to
 * them.
 *
 * Reporting lines are the one part of the write that depends on order —
 * admission and employment are single batch calls that have no opinion about who
 * reports to whom — so this is what the ordering is for. Anything still unplaced
 * after the sweep sits in a cycle and is reported separately.
 */
export function managersFirst(
  emails: readonly string[],
  edges: readonly ManagerEdge[],
): string[] {
  const managerOf = new Map(edges.map((edge) => [edge.email, edge.managerEmail]));
  const known = new Set(emails);
  const placed = new Set<string>();
  const ordered: string[] = [];

  const place = (email: string, seen: Set<string>): void => {
    if (placed.has(email) || seen.has(email)) return;
    seen.add(email);
    const manager = managerOf.get(email);
    if (manager !== undefined && known.has(manager)) place(manager, seen);
    if (placed.has(email)) return;
    placed.add(email);
    ordered.push(email);
  };

  for (const email of emails) place(email, new Set());
  return ordered;
}
