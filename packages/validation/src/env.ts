import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Environment contract shared by API, desktop shell and scripts.
 * Spec section 38: the API binds to loopback only; non-loopback hosts are rejected.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().default('127.0.0.1').refine(isLoopbackHost, {
    message: 'API_HOST must be a loopback address (127.0.0.1, localhost or ::1)',
  }),
  API_PORT: z.coerce.number().int().min(1024).max(65535).default(4310),
  WEB_ORIGIN: z
    .string()
    .default('http://127.0.0.1:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),
  DATABASE_URL: z.string().refine((v) => /^postgres(ql)?:\/\//.test(v), {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  }),
});

export type AppEnv = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    // Only variable names and rule messages are reported - never values (they may be secrets).
    super(`Invalid environment configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseEnv(source: Record<string, string | undefined>): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}
