import postgres from 'postgres';
const url = process.env.LOCAL_URL;
const sql = postgres(url, { max: 1, prepare: false, ssl: false });
try {
  const ver = await sql`select current_database() db, version()`;
  console.log('DB:', ver[0].db);
  const tbls = await sql`select count(*)::int c from information_schema.tables where table_schema='public'`;
  console.log('public tables:', tbls[0].c);
  const billing = await sql`select table_name from information_schema.tables where table_schema='public' and (table_name like '%invoice%' or table_name like '%subscription%' or table_name like '%provider_webhook%' or table_name like '%credit%') order by 1 limit 40`;
  console.log('billing-ish tables:', billing.map(r=>r.table_name).join(', '));
  const j = await sql`select count(*)::int c from drizzle.__drizzle_migrations`.catch(()=>[{c:'NO drizzle schema'}]);
  console.log('drizzle migrations rows:', j[0].c);
  const orgs = await sql`select count(*)::int c from organizations`.catch(e=>[{c:'ERR '+e.message.slice(0,60)}]);
  console.log('organizations rows:', orgs[0].c);
} catch(e){ console.log('PROBE ERROR:', e.message.slice(0,200)); }
finally { await sql.end(); }
