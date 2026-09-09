import postgres from 'postgres';
const url = process.env.LU;
async function attempt(label, opts){
  const sql = postgres(url, { max:1, prepare:false, connect_timeout:8, ...opts });
  try { const r = await sql`select 1 as x`; console.log(label, 'OK', r[0].x); }
  catch(e){ console.log(label, 'ERR', JSON.stringify({code:e.code,errno:e.errno,syscall:e.syscall,msg:(e.message||'').slice(0,120)})); }
  finally { try{ await sql.end({timeout:2}); }catch{} }
}
await attempt('withURLsslmode', {});
await attempt('ssl:false', { ssl:false });
await attempt('ssl:prefer', { ssl:'prefer' });
