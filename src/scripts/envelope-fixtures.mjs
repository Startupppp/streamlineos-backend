export const KEY_PREFIX = "SE";
export const USER_EMAIL_PATTERN = "seed-envelope-%@seed.local";
export const ORG_PERSON_ID_PREFIX = "seop-";

export async function seedMembers(sql, org, count, chunk) {
  await sql`set statement_timeout = 0`;

  await sql.unsafe(`
    INSERT INTO users (id, email, first_name, last_name, is_active, user_status, created_at, updated_at)
    SELECT
      'se-' || lpad(g::text, 6, '0'),
      'seed-envelope-' || g || '@seed.local',
      'Seed' || g,
      'User' || g,
      true, 'active', now(), now()
    FROM generate_series(1, ${count}) g
    ON CONFLICT (email) DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO organization_members (user_id, org_id, role, status, joined_at)
    SELECT u.id, '${org}', 'MEMBER', 'ACTIVE',
           now() - ((row_number() OVER (ORDER BY u.id) % 730) || ' days')::interval
    FROM users u
    WHERE u.email LIKE 'seed-envelope-%@seed.local'
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO organization_people
      (organization_person_id, organization_id, user_id, first_name, last_name, work_email, created_at, updated_at)
    SELECT
      '${ORG_PERSON_ID_PREFIX}' || lpad(rn::text, 6, '0'),
      '${org}',
      u.id,
      'Seed' || rn,
      'Person' || rn,
      'seed-envelope-' || rn || '@seed.local',
      now(), now()
    FROM (
      SELECT id, row_number() OVER (ORDER BY email) AS rn
      FROM users WHERE email LIKE 'seed-envelope-%@seed.local'
    ) u
    ON CONFLICT DO NOTHING`);
}

export async function seedHR(sql, org, employmentCount) {
  await sql.unsafe(`
    INSERT INTO hr_people (org_id, user_id, organization_person_id, row_version, created_at, updated_at)
    SELECT '${org}', u.id, '${ORG_PERSON_ID_PREFIX}' || lpad(rn::text, 6, '0'), 1, now(), now()
    FROM (
      SELECT id, row_number() OVER (ORDER BY email) AS rn
      FROM users WHERE email LIKE 'seed-envelope-%@seed.local'
      LIMIT ${employmentCount}
    ) u
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO hr_employments (org_id, person_id, employee_number, is_primary, created_at, updated_at)
    SELECT '${org}', hp.id, 'SE-EMP-' || lpad(hp.id::text, 7, '0'), true, now(), now()
    FROM hr_people hp
    WHERE hp.org_id = '${org}' AND hp.organization_person_id LIKE '${ORG_PERSON_ID_PREFIX}%'
    ON CONFLICT DO NOTHING`);

  const [mgr] = await sql.unsafe(
    `SELECT e.id FROM hr_employments e
     JOIN hr_people hp ON hp.id = e.person_id
     WHERE e.org_id = '${org}' AND hp.organization_person_id LIKE '${ORG_PERSON_ID_PREFIX}%'
     ORDER BY e.id ASC LIMIT 1`);
  if (!mgr) return;

  await sql.unsafe(`
    INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from, effective_to)
    SELECT
      '${org}',
      e.id,
      ${mgr.id},
      'primary',
      CURRENT_DATE - ((row_number() OVER (ORDER BY e.id) % 365) || ' days')::interval,
      '2099-12-31'::date
    FROM hr_employments e
    JOIN hr_people hp ON hp.id = e.person_id
    WHERE e.org_id = '${org}'
      AND hp.organization_person_id LIKE '${ORG_PERSON_ID_PREFIX}%'
      AND e.id <> ${mgr.id}
    ON CONFLICT DO NOTHING`);
}

export async function seedNotifications(sql, org, count) {
  const [existing] = await sql.unsafe(
    `SELECT count(*)::int c FROM notifications WHERE org_id = '${org}' AND title LIKE 'SE: Notification%'`);
  if (existing.c >= count) return;

  const users = await sql.unsafe(`
    SELECT user_id FROM organization_members WHERE org_id = '${org}' AND status = 'ACTIVE'
    ORDER BY joined_at DESC LIMIT 200`);
  if (!users.length) return;

  const usersArr = users.map((r) => r.user_id);
  const perUser = Math.ceil(count / usersArr.length);

  for (const uid of usersArr) {
    await sql.unsafe(`
      INSERT INTO notifications (org_id, user_id, type, priority, category, title, message, is_read, created_at, updated_at)
      SELECT
        '${org}', '${uid}',
        (ARRAY['INFO','SUCCESS','WARNING'])[1 + (g % 3)]::notification_type,
        (ARRAY['LOW','NORMAL','HIGH'])[1 + (g % 3)]::notification_priority,
        (ARRAY['SYSTEM','HRMS','PROJECTS'])[1 + (g % 3)]::notification_category,
        'SE: Notification ' || g || ' for user', 'Seeded notification body ' || g,
        (g % 3 <> 0), now() - ((g % 90) || ' days')::interval, now()
      FROM generate_series(1, ${perUser}) g`);
  }
}

export async function seedChat(sql, org, ownerUserId, channelCount, msgCount) {
  const [existCh] = await sql.unsafe(
    `SELECT count(*)::int c FROM chat_channels WHERE org_id = '${org}' AND name LIKE 'SE:%'`);
  if (existCh.c < channelCount) {
    await sql.unsafe(`
      INSERT INTO chat_channels (org_id, name, type, created_by, is_archived, is_private, created_at, updated_at)
      SELECT '${org}', 'SE: Channel ' || g,
        CASE WHEN g % 4 = 0 THEN 'dm' ELSE 'channel' END,
        '${ownerUserId}', false, false, now(), now()
      FROM generate_series(${existCh.c + 1}, ${channelCount}) g`);
  }

  await sql.unsafe(`
    INSERT INTO chat_channel_members (channel_id, user_id, org_id, role, joined_at)
    SELECT c.id, u.user_id, '${org}', 'member', now()
    FROM (SELECT id FROM chat_channels WHERE org_id = '${org}' AND name LIKE 'SE:%') c
    JOIN (SELECT user_id FROM organization_members WHERE org_id = '${org}' ORDER BY user_id LIMIT 20) u ON true
    ON CONFLICT DO NOTHING`);

  const [existMsg] = await sql.unsafe(
    `SELECT count(*)::int c FROM chat_messages WHERE org_id = '${org}' AND content LIKE 'SE: seeded%'`);
  if (existMsg.c < msgCount) {
    const need = msgCount - existMsg.c;
    await sql.unsafe(`
      INSERT INTO chat_messages (channel_id, sender_id, org_id, content, message_type, is_edited, is_deleted, created_at, updated_at)
      SELECT c.id, '${ownerUserId}', '${org}', 'SE: seeded message ' || g,
        'text', false, false, now() - ((g % 180) || ' days')::interval, now()
      FROM generate_series(1, ${need}) g
      JOIN LATERAL (
        SELECT id FROM chat_channels WHERE org_id = '${org}' AND name LIKE 'SE:%'
        OFFSET ((g - 1) % ${channelCount}) LIMIT 1
      ) c ON true`);
  }

  const [existSaved] = await sql.unsafe(
    `SELECT count(*)::int c FROM chat_saved_messages WHERE org_id = '${org}'`);
  if (existSaved.c < 60) {
    await sql.unsafe(`
      INSERT INTO chat_saved_messages (user_id, message_id, org_id, saved_at)
      SELECT '${ownerUserId}', m.id, '${org}', now()
      FROM (SELECT id FROM chat_messages WHERE org_id = '${org}' ORDER BY id DESC LIMIT 60) m
      ON CONFLICT DO NOTHING`);
  }
}

export async function seedKB(sql, org, ownerUserId, spaceCount, pageCount) {
  for (let i = 1; i <= spaceCount; i++) {
    await sql.unsafe(`
      INSERT INTO kb_spaces (org_id, name, slug, audience, type, created_by_id, created_at, updated_at)
      VALUES ('${org}', 'SE Space ${i}', 'se-space-${i}', 'internal', 'knowledge', '${ownerUserId}', now(), now())
      ON CONFLICT DO NOTHING`);
  }

  await sql.unsafe(`
    INSERT INTO kb_pages (org_id, space_id, title, status, visibility, sort_order, created_by_id, last_edited_by_id, created_at, updated_at)
    SELECT
      '${org}',
      s.id,
      'SE Page ' || g,
      'published',
      'internal',
      g,
      '${ownerUserId}',
      '${ownerUserId}',
      now() - ((g % 200) || ' days')::interval,
      now() - ((g % 60) || ' days')::interval
    FROM generate_series(1, ${pageCount}) g
    JOIN LATERAL (
      SELECT id FROM kb_spaces WHERE org_id = '${org}' AND name LIKE 'SE %'
      OFFSET ((g - 1) % ${spaceCount}) LIMIT 1
    ) s ON true
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO kb_page_visits (org_id, page_id, user_id, visited_at)
    SELECT
      '${org}',
      p.id,
      u.user_id,
      now() - ((row_number() OVER () % 90) || ' days')::interval
    FROM (SELECT id FROM kb_pages WHERE org_id = '${org}' AND title LIKE 'SE Page%' LIMIT 50) p
    JOIN (SELECT user_id FROM organization_members WHERE org_id = '${org}' ORDER BY user_id LIMIT 10) u ON true
    ON CONFLICT DO NOTHING`);
}

export async function seedLeave(sql, org, leaveTypeIds) {
  const users = await sql.unsafe(`SELECT user_id FROM organization_members WHERE org_id = '${org}' ORDER BY user_id LIMIT 200`);
  if (!users.length || !leaveTypeIds.length) return;

  const usersArr = users.map((r) => r.user_id);

  await sql.unsafe(`
    INSERT INTO leave_requests (org_id, user_id, leave_type_id, start_date, end_date, status, created_at, updated_at)
    SELECT
      '${org}',
      u.uid,
      (ARRAY[${leaveTypeIds.join(",")}])[1 + (row_number() OVER () % ${leaveTypeIds.length})],
      CURRENT_DATE - ((row_number() OVER () % 200) || ' days')::interval,
      CURRENT_DATE - ((row_number() OVER () % 200 - 2) || ' days')::interval,
      (ARRAY['PENDING','APPROVED','APPROVED','REJECTED'])[1 + (row_number() OVER () % 4)]::leave_status,
      now(), now()
    FROM (SELECT unnest(ARRAY[${usersArr.map((u) => `'${u}'`).join(",")}]::text[]) AS uid) u
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO leave_balances (org_id, user_id, leave_type_id, balance, year)
    SELECT
      '${org}',
      u.uid,
      lt.id,
      (10 + (row_number() OVER () % 21))::numeric,
      2026
    FROM (SELECT unnest(ARRAY[${usersArr.map((u) => `'${u}'`).join(",")}]::text[]) AS uid) u
    CROSS JOIN (SELECT id FROM leave_types WHERE org_id = '${org}') lt
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO hr_leave_ledger (org_id, user_id, leave_type_id, txn_type, days, effective_date, period, source, created_at)
    SELECT
      '${org}',
      u.uid,
      (ARRAY[${leaveTypeIds.join(",")}])[1 + (row_number() OVER () % ${leaveTypeIds.length})],
      'accrual',
      (1 + (row_number() OVER () % 3))::numeric,
      CURRENT_DATE - ((row_number() OVER () % 365) || ' days')::interval,
      '2026-01',
      'cron',
      now()
    FROM (SELECT unnest(ARRAY[${usersArr.map((u) => `'${u}'`).join(",")}]::text[]) AS uid) u
    ON CONFLICT DO NOTHING`);

  await sql.unsafe(`
    INSERT INTO attendance (org_id, user_id, date, status, check_in, check_out, created_at)
    SELECT
      '${org}',
      u.uid,
      CURRENT_DATE - ((row_number() OVER () % 60) || ' days')::interval,
      'present',
      (CURRENT_DATE - ((row_number() OVER () % 60) || ' days')::interval + '09:00:00'::interval),
      (CURRENT_DATE - ((row_number() OVER () % 60) || ' days')::interval + '18:00:00'::interval),
      now()
    FROM (SELECT unnest(ARRAY[${usersArr.slice(0, 30).map((u) => `'${u}'`).join(",")}]::text[]) AS uid) u
    ON CONFLICT DO NOTHING`);
}
