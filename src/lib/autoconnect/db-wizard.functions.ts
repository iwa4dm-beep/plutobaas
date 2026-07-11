// Server function: validate DB connection string shape and reachability (TCP probe).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  driver: z.enum(["postgres", "mysql"]),
  url: z.string().min(1),
});

const PG_RE = /^postgres(?:ql)?:\/\/([^:@\/]+)(?::([^@\/]*))?@([^:\/]+)(?::(\d+))?\/([^?]+)/;
const MY_RE = /^mysql:\/\/([^:@\/]+)(?::([^@\/]*))?@([^:\/]+)(?::(\d+))?\/([^?]+)/;

export const validateDbConnection = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    const re = data.driver === "postgres" ? PG_RE : MY_RE;
    const m = data.url.match(re);
    if (!m) {
      return {
        ok: false,
        parsed: null,
        message: `URL format invalid — expected ${data.driver}://user:pass@host:port/database`,
      };
    }
    const parsed = {
      user: m[1],
      host: m[3],
      port: Number(m[4] ?? (data.driver === "postgres" ? 5432 : 3306)),
      database: m[5],
    };

    // Lightweight TCP reachability probe (3s timeout).
    let reachable = false;
    let probeError: string | undefined;
    try {
      const net = await import("node:net");
      reachable = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        const done = (v: boolean, err?: string) => {
          probeError = err;
          try { socket.destroy(); } catch { /* ignore */ }
          resolve(v);
        };
        socket.setTimeout(3000);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false, "timeout"));
        socket.once("error", (e) => done(false, (e as Error).message));
        socket.connect(parsed.port, parsed.host);
      });
    } catch (e) {
      probeError = (e as Error).message;
    }

    return {
      ok: reachable,
      parsed,
      message: reachable
        ? `✔ TCP reachable at ${parsed.host}:${parsed.port}`
        : `URL parsed OK, but TCP probe failed: ${probeError ?? "unreachable"}`,
    };
  });

export function buildDbConfigTs(driver: "postgres" | "mysql", url: string): string {
  if (driver === "postgres") {
    return `// Auto-generated Pluto DB config — PostgreSQL
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? ${JSON.stringify(url)},
  max: 10,
  idleTimeoutMillis: 30_000,
});
`;
  }
  return `// Auto-generated Pluto DB config — MySQL (translated to PG runtime via mysql-to-pg on migrations)
import mysql from "mysql2/promise";

export const pool = mysql.createPool({
  uri: process.env.DATABASE_URL ?? ${JSON.stringify(url)},
  connectionLimit: 10,
});
`;
}
