/**
 * Dashboard tiles — the reads that run on every landing page load.
 *
 * Transcribed from the service that owns each query: same projection, same predicates, same
 * ORDER BY, same LIMIT. A `compare` tag pairs two shapes so the runner prints them adjacently.
 */

export const DASHBOARD_QUERIES = [
  {
    id: "dashboard-unread-notifications",
    category: "dashboard",
    source: "modules/dashboard/dashboard-personal.service.ts",
    params: (f) => [f.orgId, f.membershipId],
    sql: `
      SELECT count(*)::int AS count
      FROM notifications
      WHERE org_id = $1 AND membership_id = $2
        AND is_read = false AND deleted_at IS NULL AND archived_at IS NULL`,
  },
  {
    id: "dashboard-upcoming-events",
    category: "dashboard",
    source: "modules/dashboard/dashboard-personal.service.ts:113",
    note: "visibility OR two correlated EXISTS, evaluated per row before LIMIT 3 can stop",
    params: (f) => [f.orgId, f.now, f.userId],
    sql: `
      SELECT ce.id, ce.title, ce.start_date, ce.end_date, ce.category
      FROM calendar_events ce
      WHERE ce.org_id = $1
        AND ce.start_date >= $2
        AND ( ce.visibility = 'org'
              OR EXISTS (SELECT 1 FROM organization_members om
                         WHERE om.org_id = ce.org_id
                           AND om.id = ce.created_by_membership_id
                           AND om.user_id = $3 AND om.status = 'ACTIVE')
              OR EXISTS (SELECT 1 FROM event_attendees ea
                         INNER JOIN organization_members om2
                           ON ea.org_id = om2.org_id AND ea.membership_id = om2.id
                         WHERE ea.org_id = $1 AND ea.event_id = ce.id
                           AND om2.user_id = $3 AND om2.status = 'ACTIVE'
                           AND ea.status <> 'declined') )
      ORDER BY ce.start_date ASC
      LIMIT 3`,
  },
  {
    id: "dashboard-recent-activity-fullrow",
    category: "dashboard",
    compare: "dashboard-recent-activity",
    source: "modules/dashboard/dashboard-project.service.ts:215",
    note: "as shipped: findMany with no columns option — all ticket columns plus a full organization_members row",
    params: (f) => [f.orgId, f.projectIds],
    sql: `
      SELECT t.*, p.id AS p_id, p.name AS p_name, p.key AS p_key,
             a.*, au.id AS au_id, au.first_name, au.last_name, au.image
      FROM build.tickets t
      LEFT JOIN build.projects p ON p.id = t.project_id
      LEFT JOIN organization_members a ON a.id = t.assignee_membership_id
      LEFT JOIN users au ON au.id = a.user_id
      WHERE t.org_id = $1 AND t.project_id = ANY($2::int[]) AND t.deleted_at IS NULL
      ORDER BY t.updated_at DESC
      LIMIT 10`,
  },
  {
    id: "dashboard-recent-activity-projected",
    category: "dashboard",
    compare: "dashboard-recent-activity",
    note: "the same rows with the eight fields the tile renders",
    params: (f) => [f.orgId, f.projectIds],
    sql: `
      SELECT t.id, t.title, t.status, t.updated_at, p.id AS p_id, p.name AS p_name, p.key AS p_key,
             au.id AS au_id, au.first_name, au.last_name, au.image
      FROM build.tickets t
      LEFT JOIN build.projects p ON p.id = t.project_id
      LEFT JOIN organization_members a ON a.id = t.assignee_membership_id
      LEFT JOIN users au ON au.id = a.user_id
      WHERE t.org_id = $1 AND t.project_id = ANY($2::int[]) AND t.deleted_at IS NULL
      ORDER BY t.updated_at DESC
      LIMIT 10`,
  },
  {
    id: "dashboard-announcements",
    category: "dashboard",
    source: "modules/dashboard/dashboard-announcements.service.ts:25",
    note: "no index satisfies (is_pinned DESC, created_at DESC), so a sort is unavoidable",
    params: (f) => [f.orgId, f.now],
    sql: `
      SELECT an.id, an.content, an.is_pinned, an.expires_at, an.created_at, an.author_id,
             u.name, u.first_name, u.last_name
      FROM announcements an
      INNER JOIN users u ON an.author_id = u.id
      WHERE an.org_id = $1 AND an.status <> 'DRAFT'
        AND (an.expires_at IS NULL OR an.expires_at > $2)
      ORDER BY an.is_pinned DESC, an.created_at DESC
      LIMIT 20`,
  },
  {
    id: "dashboard-recent-notifications",
    category: "dashboard",
    source: "modules/dashboard/dashboard-personal.service.ts",
    params: (f) => [f.orgId, f.membershipId],
    sql: `
      SELECT id, title, message, category, created_at
      FROM notifications
      WHERE org_id = $1 AND membership_id = $2 AND deleted_at IS NULL AND archived_at IS NULL
      ORDER BY id DESC
      LIMIT 5`,
  },
  {
    id: "dashboard-member-headcount",
    category: "dashboard",
    source: "modules/dashboard/dashboard-stats.service.ts",
    params: (f) => [f.orgId],
    sql: `
      SELECT count(*)::int AS count
      FROM organization_members
      WHERE org_id = $1 AND status = 'ACTIVE'`,
  },
];
