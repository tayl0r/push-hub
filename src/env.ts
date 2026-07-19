import { z } from 'zod'
const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),
  PUSH_HUB_TENANTS: z.string().default('[]'),
  GLITCHTIP_DSN: z.string().default(''),
  SENTRY_ENVIRONMENT: z.string().default('development'),
})
export const env = schema.parse(process.env)
