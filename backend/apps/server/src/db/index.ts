import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { env } from "../config.js";

export type Database = {
  users: {
    id: string;
    email: string;
    password_hash: string;
    role: "admin" | "user";
    email_verified: boolean;
    created_at: Date;
  };
  refresh_tokens: {
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: Date;
    revoked_at: Date | null;
  };
  buckets: {
    name: string;
    public: boolean;
    created_at: Date;
  };
  objects: {
    id: string;
    bucket: string;
    key: string;
    size: number;
    content_type: string;
    owner_id: string | null;
    created_at: Date;
  };
  api_logs: {
    id: string;
    ts: Date;
    level: "info" | "warn" | "error";
    source: "auth" | "rest" | "storage" | "admin";
    message: string;
    user_id: string | null;
  };
  oauth_accounts: {
    id: string;
    user_id: string;
    provider: "google" | "github";
    provider_user_id: string;
    created_at: Date;
  };
  edge_functions: {
    slug: string;
    code: string;
    runtime: "js";
    timeout_ms: number;
    public: boolean;
    created_by: string | null;
    updated_at: Date;
  };
};

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 }),
  }),
});
