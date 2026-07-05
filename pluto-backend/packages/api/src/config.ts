import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().url(),
  PLUTO_JWT_SECRET: z.string().min(32, 'PLUTO_JWT_SECRET must be at least 32 chars'),
  JWT_ISSUER: z.string().default('pluto'),
  JWT_ACCESS_TTL: z.coerce.number().default(3600),
  JWT_REFRESH_TTL: z.coerce.number().default(2592000),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().default('pluto'),
  REDIS_URL: z.string().optional(),
  CORS_ORIGINS: z.string().default('*'),
  BODY_LIMIT_MB: z.coerce.number().default(100),
  RATE_LIMIT_GLOBAL: z.coerce.number().default(300),
  RATE_LIMIT_AUTH: z.coerce.number().default(10),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
