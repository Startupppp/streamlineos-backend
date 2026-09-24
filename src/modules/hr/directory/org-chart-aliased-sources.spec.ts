import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  orgChartChildMembersSource,
  orgChartChildUsersSource,
  orgChartManagerMembersSource,
  orgChartManagerUsersSource,
  rlChildEmpEmpSource,
  rlChildEmpPplSource,
  rlChildMgrEmpSource,
  rlChildMgrPplSource,
  rlChildSource,
  rlVisEmpEmpSource,
  rlVisEmpPplSource,
  rlVisMgrEmpSource,
  rlVisMgrPplSource,
  rlVisSource,
} from "./org-chart-helpers";

const dialect = new PgDialect();

function render(fragment: SQL): string {
  return dialect.sqlToQuery(sql`${fragment}`).sql;
}

const SOURCES: ReadonlyArray<readonly [SQL, string, string]> = [
  [rlVisSource, "hr_reporting_lines", "rl_vis"],
  [rlVisEmpEmpSource, "hr_employments", "rl_vis_emp_emp"],
  [rlVisEmpPplSource, "hr_people", "rl_vis_emp_ppl"],
  [rlVisMgrEmpSource, "hr_employments", "rl_vis_mgr_emp"],
  [rlVisMgrPplSource, "hr_people", "rl_vis_mgr_ppl"],
  [rlChildSource, "hr_reporting_lines", "rl_child"],
  [rlChildMgrEmpSource, "hr_employments", "rl_child_mgr_emp"],
  [rlChildMgrPplSource, "hr_people", "rl_child_mgr_ppl"],
  [rlChildEmpEmpSource, "hr_employments", "rl_child_emp_emp"],
  [rlChildEmpPplSource, "hr_people", "rl_child_emp_ppl"],
  [orgChartManagerMembersSource, "organization_members", "org_chart_manager_members"],
  [orgChartManagerUsersSource, "users", "org_chart_manager_users"],
  [orgChartChildMembersSource, "organization_members", "org_chart_child_members"],
  [orgChartChildUsersSource, "users", "org_chart_child_users"],
];

describe("org chart aliased sources", () => {
  it.each(SOURCES.map(([source, base, aliasName]) => [aliasName, source, base] as const))(
    "%s names its base table, so Postgres is not asked for a relation that is only an alias",
    (aliasName, source, base) => {
      expect(render(source)).toBe(`"${base}" "${aliasName}"`);
    },
  );

  it("never renders a bare alias, the shape that made every org chart request fail with 42P01", () => {
    for (const [source, , aliasName] of SOURCES)
      expect(render(source)).not.toBe(`"${aliasName}"`);
  });
});
