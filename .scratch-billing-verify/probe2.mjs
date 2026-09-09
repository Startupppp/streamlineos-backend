import postgres from 'postgres';
const sql = postgres(process.env.LU, { max:1, prepare:false, ssl:false, connect_timeout:10, idle_timeout:5 });
try {
  const r = await sql`select current_database() db`;
  console.log('OK db=', r[0].db);
} catch(e){ console.log('ERR:', e.code||'', e.message.slice(0,160)); }
finally { try{await sql.end({timeout:3})}catch{} }
