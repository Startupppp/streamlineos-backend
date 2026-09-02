/**
 * The named heavy read paths, transcribed from the services that own them.
 *
 * Each entry is the SQL the service's Drizzle builder emits, with the same projection, the same
 * predicates in the same order, the same ORDER BY and the same LIMIT. Where an entry deviates it
 * says so in `note`, and where two shapes are being compared the pair shares a `compare` tag so
 * the runner prints them adjacently and the buffer counts decide.
 */

export const CATEGORIES = [
  "reminder",
  "export",
  "fanout",
  "unread",
  "free/busy",
  "recurrence",
  "search/vector",
  "dashboard",
];

export const QUERIES = [
  // ── reminder ──────────────────────────────────────────────────────────────
  {
    id: "reminder-nonrecurring-due",
    category: "reminder",
    source: "modules/calendar/calendar-reminder-sweep.service.ts:47",
    params: (f) => [f.orgId, f.now, f.dueBy],
    sql: `
      SELECT id, title, start_date
      FROM calendar_events
      WHERE org_id = $1
        AND reminder_15min_sent = false
        AND all_day = false
        AND rrule IS NULL
        AND start_date >= $2
        AND start_date <= $3
      LIMIT 200`,
  },
  {
    id: "reminder-recurring-candidates",
    category: "reminder",
    source: "modules/calendar/calendar-reminder-sweep.service.ts:61",
    note: "start_date <= dueBy admits the org's entire history; LIMIT 200 with no ORDER BY",
    params: (f) => [f.orgId, f.dueBy, f.now],
    sql: `
      SELECT id, title, start_date, end_date, all_day, timezone, org_id, rrule, recurrence_end
      FROM calendar_events
      WHERE org_id = $1
        AND all_day = false
        AND rrule IS NOT NULL
        AND start_date <= $2
        AND (recurrence_end IS NULL OR recurrence_end >= $3)
      LIMIT 200`,
  },
  {
    id: "reminder-exception-window",
    category: "reminder",
    source: "modules/calendar/calendar-reminder-sweep.service.ts:86",
    params: (f) => [f.orgId, f.recurringIds, f.now, f.dueBy],
    sql: `
      SELECT event_id, occurrence_start, is_cancelled, modified_start, modified_title
      FROM calendar_event_exceptions
      WHERE org_id = $1
        AND event_id = ANY($2::int[])
        AND ( (occurrence_start >= $3 AND occurrence_start <= $4)
           OR (modified_start IS NOT NULL AND modified_start >= $3 AND modified_start <= $4) )
      LIMIT 2000`,
  },
  {
    id: "reminder-attendee-fanout-page",
    category: "reminder",
    source: "modules/calendar/calendar-reminder-sweep.service.ts:204",
    params: (f) => [f.orgId, f.dueEventIds, 0],
    sql: `
      SELECT ea.id, ea.event_id, om.user_id, ea.membership_id
      FROM event_attendees ea
      INNER JOIN organization_members om
        ON om.org_id = ea.org_id AND om.id = ea.membership_id
      WHERE ea.org_id = $1
        AND om.status = 'ACTIVE'
        AND ea.event_id = ANY($2::int[])
        AND ea.id > $3
      ORDER BY ea.id ASC
      LIMIT 1000`,
  },

  // ── export ────────────────────────────────────────────────────────────────
  {
    id: "export-calendar-range",
    category: "export",
    source: "modules/calendar/calendar-export.service.ts:57",
    note: "OR-of-two-branches range predicate plus a three-way visibility OR over a LEFT JOIN",
    params: (f) => [f.orgId, f.membershipId, f.rangeFrom, f.rangeTo],
    sql: `
      SELECT ce.id, ce.title, ce.start_date, ce.end_date, ce.all_day, ce.timezone, ce.category,
             ce.location, ce.description, ce.color, ce.rrule, ce.recurrence_end
      FROM calendar_events ce
      LEFT JOIN event_attendees exp_caller_att
        ON exp_caller_att.org_id = ce.org_id
       AND exp_caller_att.event_id = ce.id
       AND exp_caller_att.membership_id = $2
      WHERE ce.org_id = $1
        AND ( (ce.rrule IS NULL AND ce.start_date < $4 AND ce.end_date > $3)
           OR (ce.rrule IS NOT NULL AND ce.start_date < $4
               AND (ce.recurrence_end IS NULL OR ce.recurrence_end > $3)) )
        AND (ce.visibility = 'org'
             OR ce.created_by_membership_id = $2
             OR exp_caller_att.id IS NOT NULL)
      ORDER BY ce.start_date ASC
      LIMIT 500`,
  },

  // ── fanout ────────────────────────────────────────────────────────────────
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

  // ── unread ────────────────────────────────────────────────────────────────
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

  // ── free/busy ─────────────────────────────────────────────────────────────
  {
    id: "freebusy-conflict-first-page",
    category: "free/busy",
    source: "modules/calendar/calendar-conflict.service.ts:56",
    note: "one page of a keyset loop that consumes every page into memory — no overall cap",
    params: (f) => [f.orgId, f.busyFrom, f.busyTo],
    sql: `
      SELECT id, title, start_date, end_date, all_day, timezone, org_id,
             created_by_membership_id, rrule, recurrence_end
      FROM calendar_events
      WHERE org_id = $1
        AND ( (rrule IS NULL AND start_date < $3 AND end_date > $2)
           OR (rrule IS NOT NULL AND start_date < $3
               AND (recurrence_end IS NULL OR recurrence_end > $2)) )
      ORDER BY start_date ASC, id ASC
      LIMIT 100`,
  },
  {
    id: "freebusy-conflict-total-rows",
    category: "free/busy",
    note: "the same predicate uncapped — how many rows the keyset loop will actually accumulate",
    params: (f) => [f.orgId, f.busyFrom, f.busyTo],
    sql: `
      SELECT count(*)::int AS count
      FROM calendar_events
      WHERE org_id = $1
        AND ( (rrule IS NULL AND start_date < $3 AND end_date > $2)
           OR (rrule IS NOT NULL AND start_date < $3
               AND (recurrence_end IS NULL OR recurrence_end > $2)) )`,
  },
  {
    id: "freebusy-ooo-leave",
    category: "free/busy",
    source: "modules/calendar/calendar-conflict.service.ts:181",
    note: "joins global users but projects only users.name",
    params: (f) => [f.orgId, f.attendeeUserIds, f.busyFromDate, f.busyToDate],
    sql: `
      SELECT lr.user_id, u.name, lr.start_date, lr.end_date
      FROM leave_requests lr
      INNER JOIN users u ON u.id = lr.user_id
      WHERE lr.org_id = $1
        AND lr.status = 'APPROVED'
        AND lr.user_id = ANY($2::text[])
        AND lr.start_date <= $4
        AND lr.end_date >= $3`,
  },

  // ── recurrence ────────────────────────────────────────────────────────────
  {
    id: "recurrence-exceptions-uncapped",
    category: "recurrence",
    source: "modules/calendar/calendar-conflict.service.ts:110",
    note: "no LIMIT — every exception row for every recurring event on the page",
    params: (f) => [f.orgId, f.recurringIds],
    sql: `
      SELECT event_id, occurrence_start, is_cancelled, modified_title, modified_start, modified_end
      FROM calendar_event_exceptions
      WHERE org_id = $1 AND event_id = ANY($2::int[])`,
  },
  {
    id: "recurrence-series-page",
    category: "recurrence",
    note: "the recurring master rows a range expansion starts from",
    params: (f) => [f.orgId, f.rangeFrom, f.rangeTo],
    sql: `
      SELECT id, title, start_date, end_date, timezone, rrule, recurrence_end
      FROM calendar_events
      WHERE org_id = $1
        AND rrule IS NOT NULL
        AND start_date < $3
        AND (recurrence_end IS NULL OR recurrence_end > $2)
      ORDER BY start_date ASC
      LIMIT 500`,
  },

  // ── search / vector ───────────────────────────────────────────────────────
  {
    id: "vector-ann-security-definer",
    category: "search/vector",
    compare: "ann",
    source: "app.search_kb_chunk_ids (migration-defined SECURITY DEFINER wrapper)",
    note: "the only ANN entry point; its CTE is AS MATERIALIZED",
    params: (f) => [f.queryVector],
    sql: `SELECT id FROM app.search_kb_chunk_ids($1::vector, 20) AS id`,
  },
  {
    id: "vector-ann-direct-under-rls",
    category: "search/vector",
    compare: "ann",
    note: "the same search issued directly by the app role — HNSW ordering is post-filtered by RLS",
    params: (f) => [f.queryVector],
    sql: `
      SELECT id
      FROM kb_article_chunks
      ORDER BY embedding <=> $1::vector
      LIMIT 20`,
  },
  {
    id: "vector-ann-org-filtered-direct",
    category: "search/vector",
    compare: "ann",
    note: "explicit org predicate as well as RLS — does the planner still choose the HNSW index?",
    params: (f) => [f.queryVector, f.orgId],
    sql: `
      SELECT id
      FROM kb_article_chunks
      WHERE org_id = $2
      ORDER BY embedding <=> $1::vector
      LIMIT 20`,
  },
  {
    id: "search-trigram-security-definer",
    category: "search/vector",
    compare: "text-search",
    source: "app.search_kb_page_ids",
    params: (f) => [f.searchTerm],
    sql: `SELECT id FROM app.search_kb_page_ids($1, 50) AS id`,
  },
  {
    id: "search-ticket-trigram-sdf",
    category: "search/vector",
    compare: "ticket-search",
    source: "app.search_ticket_ids — the canonical SECURITY DEFINER escape",
    note: "ILIKE inside the definer, backed by idx_tickets_title_trgm; 18,500 tickets in the large org",
    params: (f) => [f.ticketTerm],
    sql: `SELECT id FROM app.search_ticket_ids($1, 50) AS id`,
  },
  {
    id: "search-ticket-ilike-under-rls",
    category: "search/vector",
    compare: "ticket-search",
    note: "the same predicate issued by the app role — trigram GIN under RLS",
    params: (f) => [f.orgId, f.ticketTermLike],
    sql: `
      SELECT id, title
      FROM build.tickets
      WHERE org_id = $1 AND deleted_at IS NULL AND title ILIKE $2
      LIMIT 50`,
  },
  {
    id: "search-kbpage-fts-under-rls",
    category: "search/vector",
    compare: "text-search",
    note: "the tsvector operator the SDF wraps, issued directly by the app role",
    params: (f) => [f.orgId, f.searchTerm],
    sql: `
      SELECT id
      FROM kb_pages
      WHERE org_id = $1 AND deleted_at IS NULL
        AND fts @@ websearch_to_tsquery('english', $2)
      LIMIT 50`,
  },
  {
    id: "search-ilike-under-rls",
    category: "search/vector",
    compare: "text-search",
    note: "the fallback the SDF exists to avoid, measured as the app role",
    params: (f) => [f.orgId, f.searchTermLike],
    sql: `
      SELECT id, title
      FROM kb_pages
      WHERE org_id = $1 AND deleted_at IS NULL AND title ILIKE $2
      ORDER BY updated_at DESC
      LIMIT 50`,
  },

  // ── dashboard ─────────────────────────────────────────────────────────────
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
