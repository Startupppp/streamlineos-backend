/**
 * Notification read paths: broadcast audience fan-out and the unread/read inbox sections.
 *
 * Transcribed from the service that owns each query: same projection, same predicates, same
 * ORDER BY, same LIMIT. A `compare` tag pairs two shapes so the runner prints them adjacently.
 */

export const NOTIFICATION_QUERIES = [
  {
    id: "fanout-all-members-page",
    category: "fanout",
    source: "modules/notifications/broadcasts-audience.queries.ts:128",
    params: (f) => [f.orgId, 0],
    sql: `
      SELECT user_id, id
      FROM organization_members
      WHERE org_id = $1 AND id > $2
      ORDER BY id ASC
      LIMIT 500`,
  },
  {
    id: "fanout-roles-exists",
    category: "fanout",
    compare: "fanout-roles",
    source: "modules/notifications/broadcasts-audience.queries.ts:63",
    params: (f) => [f.orgId, 0, f.roleIds],
    sql: `
      SELECT om.user_id, om.id
      FROM organization_members om
      WHERE om.org_id = $1
        AND om.id > $2
        AND EXISTS (
          SELECT 1 FROM role_assignments ra
          WHERE ra.org_id = $1
            AND ra.organization_membership_id = om.id
            AND ra.role_id = ANY($3::int[])
        )
      ORDER BY om.id ASC
      LIMIT 500`,
  },
  {
    id: "fanout-roles-semijoin-rewrite",
    category: "fanout",
    compare: "fanout-roles",
    note: "candidate rewrite: drive from role_assignments (the selective side) instead of the member table",
    params: (f) => [f.orgId, 0, f.roleIds],
    sql: `
      SELECT om.user_id, om.id
      FROM (
        SELECT DISTINCT ra.organization_membership_id AS id
        FROM role_assignments ra
        WHERE ra.org_id = $1 AND ra.role_id = ANY($3::int[]) AND ra.organization_membership_id > $2
      ) picked
      JOIN organization_members om ON om.org_id = $1 AND om.id = picked.id
      ORDER BY om.id ASC
      LIMIT 500`,
  },
  {
    id: "unread-count",
    category: "unread",
    source: "modules/notifications/notifications-read.service.ts:322",
    params: (f) => [f.orgId, f.membershipId, f.watermarkId],
    sql: `
      SELECT count(*)::int AS count
      FROM notifications
      WHERE org_id = $1
        AND membership_id = $2
        AND is_read = false
        AND deleted_at IS NULL
        AND archived_at IS NULL
        AND id > $3`,
  },
  {
    id: "unread-section-page",
    category: "unread",
    source: "modules/notifications/notifications-read.service.ts:218",
    params: (f) => [f.orgId, f.membershipId, f.watermarkId],
    sql: `
      SELECT id, type, priority, category, source_module, event_key, entity_type, entity_id,
             title, message, link, is_read, pinned, archived_at, created_at
      FROM notifications
      WHERE org_id = $1 AND membership_id = $2 AND deleted_at IS NULL
        AND archived_at IS NULL AND is_read = false AND id > $3
      ORDER BY id DESC
      LIMIT 20`,
  },
  {
    id: "read-section-page-or-watermark",
    category: "unread",
    compare: "read-section",
    source: "modules/notifications/notifications-read.service.ts:155",
    note: "an OR whose second branch (id <= watermark) sits outside the partial unread index",
    params: (f) => [f.orgId, f.membershipId, f.watermarkId],
    sql: `
      SELECT id, type, priority, category, source_module, event_key, entity_type, entity_id,
             title, message, link, is_read, pinned, archived_at, created_at
      FROM notifications
      WHERE org_id = $1 AND membership_id = $2 AND deleted_at IS NULL
        AND archived_at IS NULL
        AND (is_read = true OR id <= $3)
      ORDER BY id DESC
      LIMIT 20`,
  },
  {
    id: "read-section-page-union-rewrite",
    category: "unread",
    compare: "read-section",
    note: "candidate rewrite: two independently-indexed branches unioned, then ordered",
    params: (f) => [f.orgId, f.membershipId, f.watermarkId],
    sql: `
      SELECT id, type, priority, category, source_module, event_key, entity_type, entity_id,
             title, message, link, is_read, pinned, archived_at, created_at
      FROM (
        (SELECT id, type, priority, category, source_module, event_key, entity_type, entity_id,
                title, message, link, is_read, pinned, archived_at, created_at
         FROM notifications
         WHERE org_id = $1 AND membership_id = $2 AND deleted_at IS NULL AND archived_at IS NULL
           AND is_read = true
         ORDER BY id DESC LIMIT 20)
        UNION ALL
        (SELECT id, type, priority, category, source_module, event_key, entity_type, entity_id,
                title, message, link, is_read, pinned, archived_at, created_at
         FROM notifications
         WHERE org_id = $1 AND membership_id = $2 AND deleted_at IS NULL AND archived_at IS NULL
           AND is_read = false AND id <= $3
         ORDER BY id DESC LIMIT 20)
      ) branches
      ORDER BY id DESC
      LIMIT 20`,
  },
  {
    id: "unified-inbox-unread-count-by-user",
    category: "unread",
    compare: "unread-count-key",
    source: "modules/notifications/unified-inbox.service.ts:379",
    note: "keyed on user_id; every notifications index leads (org_id, membership_id, ...)",
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT count(*)::int AS count
      FROM notifications
      WHERE org_id = $1 AND user_id = $2
        AND is_read = false AND deleted_at IS NULL AND archived_at IS NULL`,
  },
  {
    id: "membership-unread-count-equivalent",
    category: "unread",
    compare: "unread-count-key",
    note: "the same count keyed on membership_id, which idx_notifications_unread_count covers",
    params: (f) => [f.orgId, f.membershipId],
    sql: `
      SELECT count(*)::int AS count
      FROM notifications
      WHERE org_id = $1 AND membership_id = $2
        AND is_read = false AND deleted_at IS NULL AND archived_at IS NULL`,
  },
  {
    id: "unified-inbox-list-by-user",
    category: "unread",
    source: "modules/notifications/unified-inbox.service.ts:232",
    note: "same missing key, plus a left join to global users for the actor",
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT n.id, n.type, n.priority, n.category, n.title, n.message, n.link, n.is_read,
             n.created_at, u.name, u.image
      FROM notifications n
      LEFT JOIN users u ON u.id = n.actor_user_id
      WHERE n.org_id = $1 AND n.user_id = $2
        AND n.deleted_at IS NULL AND n.archived_at IS NULL
      ORDER BY n.id DESC
      LIMIT 20`,
  },
  {
    id: "notification-list-search-ilike",
    category: "unread",
    source: "modules/notifications/notifications-read.service.ts:209",
    note: "leading-wildcard ILIKE — the shape backend/CLAUDE.md §3 bans for free-text search",
    params: (f) => [f.orgId, f.membershipId, "%notification 12%"],
    sql: `
      SELECT id, title, message, created_at
      FROM notifications
      WHERE org_id = $1 AND membership_id = $2 AND deleted_at IS NULL AND archived_at IS NULL
        AND (title ILIKE $3 OR message ILIKE $3)
      ORDER BY id DESC
      LIMIT 20`,
  },
];
