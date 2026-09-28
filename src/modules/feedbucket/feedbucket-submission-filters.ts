import {
  and,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  feedbucketSubmissions,
  feedbucketWidgets,
  organizationMembers,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { SubmissionFilters } from "./feedbucket.schemas";

function submissionsInManagedProductCondition(
  orgId: string,
  managedProductId: number,
): SQL {
  const widgetAlias = sql.identifier("feedbucket_widgets_scope");
  const widgetColumn = (name: string) =>
    sql`${widgetAlias}.${sql.identifier(name)}`;
  return sql`${feedbucketSubmissions.widgetId} IN (
    SELECT ${widgetColumn("id")}
    FROM ${sql.identifier("build")}.${sql.identifier("feedbucket_widgets")} AS ${widgetAlias}
    WHERE ${widgetColumn("org_id")} = ${orgId}
      AND ${widgetColumn("managed_product_id")} = ${managedProductId}
      AND ${widgetColumn("deleted_at")} IS NULL
  )`;
}

export async function resolveAssigneeMembershipId(
  db: Db,
  orgId: string,
  userId: string,
): Promise<number | null> {
  const membership = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, userId),
    ),
    columns: { id: true },
  });
  return membership?.id ?? null;
}

export async function buildSubmissionFilterConditions(
  db: Db,
  orgId: string,
  filters: SubmissionFilters,
): Promise<(SQL | undefined)[]> {
  const {
    widgetId,
    managedProductId,
    type,
    status,
    assigneeId,
    search,
    linked,
    duplicate,
    from,
    to,
  } = filters;

  const domain: (SQL | undefined)[] = [
    widgetId !== undefined
      ? eq(feedbucketSubmissions.widgetId, widgetId)
      : undefined,
    managedProductId !== undefined
      ? submissionsInManagedProductCondition(orgId, managedProductId)
      : undefined,
    type !== undefined ? eq(feedbucketSubmissions.type, type) : undefined,
    status !== undefined ? eq(feedbucketSubmissions.status, status) : undefined,
    isNull(feedbucketSubmissions.deletedAt),
  ];

  if (assigneeId !== undefined) {
    const membershipId = await resolveAssigneeMembershipId(
      db,
      orgId,
      assigneeId,
    );
    domain.push(
      eq(feedbucketSubmissions.assigneeMembershipId, membershipId ?? -1),
    );
  }
  if (search?.trim()) {
    domain.push(ilike(feedbucketSubmissions.message, `%${search}%`));
  }
  if (linked === "linked") {
    domain.push(isNotNull(feedbucketSubmissions.linkedTicketId));
  } else if (linked === "unlinked") {
    domain.push(isNull(feedbucketSubmissions.linkedTicketId));
  }
  if (duplicate === "true") {
    domain.push(sql`EXISTS (
      SELECT 1 FROM feedbucket_submissions fs2
      WHERE fs2.widget_id = ${feedbucketSubmissions.widgetId}
        AND fs2.id < ${feedbucketSubmissions.id}
        AND fs2.created_at >= ${feedbucketSubmissions.createdAt} - INTERVAL '30 days'
        AND lower(regexp_replace(left(fs2.message, 200), E'[^\\w\\s]', '', 'g'))
            = lower(regexp_replace(left(${feedbucketSubmissions.message}, 200), E'[^\\w\\s]', '', 'g'))
        AND fs2.deleted_at IS NULL
    )`);
  }
  if (duplicate === "false") {
    domain.push(sql`NOT EXISTS (
      SELECT 1 FROM feedbucket_submissions fs2
      WHERE fs2.widget_id = ${feedbucketSubmissions.widgetId}
        AND fs2.id < ${feedbucketSubmissions.id}
        AND fs2.created_at >= ${feedbucketSubmissions.createdAt} - INTERVAL '30 days'
        AND lower(regexp_replace(left(fs2.message, 200), E'[^\\w\\s]', '', 'g'))
            = lower(regexp_replace(left(${feedbucketSubmissions.message}, 200), E'[^\\w\\s]', '', 'g'))
        AND fs2.deleted_at IS NULL
    )`);
  }
  if (from !== undefined) {
    domain.push(gte(feedbucketSubmissions.createdAt, new Date(from)));
  }
  if (to !== undefined) {
    domain.push(lt(feedbucketSubmissions.createdAt, new Date(to)));
  }

  return domain;
}
