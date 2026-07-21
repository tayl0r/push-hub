import { z } from 'zod'

export const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),
  PUSH_HUB_TENANTS: z.string().default('[]'), // legacy env source; removed in the Task 9 cutover
  PUSH_HUB_ENROLL_KEY: z.string().min(1),
  PUSH_HUB_CRED_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'PUSH_HUB_CRED_KEY must be 64 hex chars (32 bytes)')
    .transform((s) => Buffer.from(s, 'hex')),
  GLITCHTIP_DSN: z.string().default(''),
  SENTRY_ENVIRONMENT: z.string().default('development'),
})

export const env = schema.parse(process.env)
