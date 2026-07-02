import postgres from "postgres";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1 });

  const statements: string[] = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_org_id text`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'users_last_active_org_id_organizations_id_fk'
       ) THEN
         ALTER TABLE users ADD CONSTRAINT users_last_active_org_id_organizations_id_fk
           FOREIGN KEY (last_active_org_id) REFERENCES organizations(id) ON DELETE SET NULL;
       END IF;
     END $$`,
    `CREATE INDEX IF NOT EXISTS idx_users_last_active_org ON users (last_active_org_id)`,
    `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_user_id text`,
    `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource_type text`,
    `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource_id text`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (org_id, resource_type, created_at)`,
    `CREATE TABLE IF NOT EXISTS email_outbox (
       id text PRIMARY KEY,
       to_email text NOT NULL,
       subject text NOT NULL,
       html text NOT NULL,
       text text,
       status text NOT NULL DEFAULT 'PENDING',
       attempts integer NOT NULL DEFAULT 0,
       next_attempt_at timestamp NOT NULL DEFAULT now(),
       last_error text,
       sent_at timestamp,
       created_at timestamp NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS email_outbox_status_next_idx ON email_outbox (status, next_attempt_at)`,
    `CREATE INDEX IF NOT EXISTS email_outbox_email_created_idx ON email_outbox (to_email, created_at)`,
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_memberships') THEN
         CREATE INDEX IF NOT EXISTS idx_user_memberships_dept ON user_memberships (department_id);
         CREATE INDEX IF NOT EXISTS idx_user_memberships_branch ON user_memberships (branch_id);
         CREATE INDEX IF NOT EXISTS idx_user_memberships_team ON user_memberships (team_id);
         CREATE INDEX IF NOT EXISTS idx_user_memberships_bu ON user_memberships (business_unit_id);
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'project_whiteboards') THEN
         ALTER TABLE project_whiteboards ALTER COLUMN data SET DEFAULT '[]'::jsonb;
         UPDATE project_whiteboards SET data = '[]'::jsonb WHERE jsonb_typeof(data) <> 'array';
       END IF;
     END $$`,
    `DROP TABLE IF EXISTS user_activity`,
  ];

  for (const statement of statements) {
    await sql.unsafe(statement);
  }

  const check = await sql`
    SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'last_active_org_id') AS users_col,
      (SELECT count(*) FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'actor_user_id') AS audit_col,
      (SELECT count(*) FROM information_schema.tables WHERE table_name = 'email_outbox') AS outbox_table,
      (SELECT count(*) FROM information_schema.tables WHERE table_name = 'user_activity') AS user_activity_table
  `;
  process.stdout.write(`${JSON.stringify(check[0])}\n`);
  await sql.end();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
