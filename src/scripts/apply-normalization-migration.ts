import postgres from "postgres";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1 });

  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS interview_panel_members (
       id serial PRIMARY KEY,
       interview_id integer NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
       org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
       user_id text NOT NULL REFERENCES users(id),
       created_at timestamp DEFAULT now() NOT NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_interview_panel_members_interview_user ON interview_panel_members(interview_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_interview_panel_members_org_user ON interview_panel_members(org_id, user_id)`,
    `CREATE TABLE IF NOT EXISTS booking_link_interviewers (
       id serial PRIMARY KEY,
       booking_link_id integer NOT NULL REFERENCES interview_booking_links(id) ON DELETE CASCADE,
       user_id text NOT NULL REFERENCES users(id),
       created_at timestamp DEFAULT now() NOT NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_link_interviewers_link_user ON booking_link_interviewers(booking_link_id, user_id)`,
    `CREATE TABLE IF NOT EXISTS calibration_participants (
       id serial PRIMARY KEY,
       session_id integer NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
       org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
       user_id text NOT NULL REFERENCES users(id),
       created_at timestamp DEFAULT now() NOT NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_calibration_participants_session_user ON calibration_participants(session_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_calibration_participants_org_user ON calibration_participants(org_id, user_id)`,
    `DO $$ BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'calibration_sessions' AND column_name = 'participant_ids'
       ) THEN
         INSERT INTO calibration_participants (session_id, org_id, user_id)
         SELECT cs.id, cs.org_id, uid.user_id
         FROM calibration_sessions cs
         CROSS JOIN LATERAL jsonb_array_elements_text(cs.participant_ids) AS uid(user_id)
         WHERE cs.participant_ids IS NOT NULL
           AND jsonb_typeof(cs.participant_ids) = 'array'
           AND jsonb_array_length(cs.participant_ids) > 0
         ON CONFLICT DO NOTHING;
       END IF;
     END $$`,
    `ALTER TABLE interviews DROP COLUMN IF EXISTS panel_interviewer_ids`,
    `ALTER TABLE interview_booking_links DROP COLUMN IF EXISTS interviewer_ids`,
    `ALTER TABLE calibration_sessions DROP COLUMN IF EXISTS participant_ids`,
    `CREATE TABLE IF NOT EXISTS announcement_targets (
       id serial PRIMARY KEY,
       announcement_id integer NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
       org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
       target_type text NOT NULL,
       target_id text NOT NULL,
       created_at timestamp DEFAULT now() NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_announcement_targets_announcement ON announcement_targets(announcement_id)`,
    `CREATE INDEX IF NOT EXISTS idx_announcement_targets_org_type_target ON announcement_targets(org_id, target_type, target_id)`,
    `ALTER TABLE announcements DROP COLUMN IF EXISTS target_ids`,
    `CREATE TABLE IF NOT EXISTS deal_meeting_attendees (
       id serial PRIMARY KEY,
       meeting_id integer NOT NULL REFERENCES deal_meetings(id) ON DELETE CASCADE,
       org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
       attendee_id text NOT NULL,
       created_at timestamp DEFAULT now() NOT NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_meeting_attendees_unique ON deal_meeting_attendees(meeting_id, attendee_id)`,
    `ALTER TABLE deal_meetings DROP COLUMN IF EXISTS attendees`,
    `ALTER TABLE roles DROP COLUMN IF EXISTS permissions`,
    `ALTER TABLE users DROP COLUMN IF EXISTS skills`,
    `ALTER TABLE users DROP COLUMN IF EXISTS experience_years`,
  ];

  for (const statement of statements) {
    await sql.unsafe(statement);
  }

  const check = await sql`
    SELECT
      (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('interview_panel_members','booking_link_interviewers','calibration_participants','announcement_targets','deal_meeting_attendees')) AS new_tables,
      (SELECT count(*)::int FROM calibration_participants) AS calibration_rows,
      (SELECT count(*) FROM information_schema.columns WHERE table_name = 'roles' AND column_name = 'permissions') AS roles_perm_col,
      (SELECT count(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('skills','experience_years')) AS users_dead_cols
  `;
  process.stdout.write(`${JSON.stringify(check[0])}\n`);
  await sql.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
