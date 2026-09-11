/**
 * Calendar read paths: the reminder sweep, the ICS export, the free/busy conflict scan and the
 * recurrence expansion's database half.
 *
 * Transcribed from the service that owns each query: same projection, same predicates, same
 * ORDER BY, same LIMIT. A `compare` tag pairs two shapes so the runner prints them adjacently.
 */

export const CALENDAR_QUERIES = [
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
];
