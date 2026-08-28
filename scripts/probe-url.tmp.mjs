import * as dotenv from "dotenv";
dotenv.config();
const u = new URL(process.env.DATABASE_URL);
u.pathname = "/migrate_probe_s2";
u.hostname = u.hostname.replace("-pooler", "");
process.stdout.write(u.toString());
