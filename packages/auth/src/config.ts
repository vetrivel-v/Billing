/**
 * Authentication configuration (ADR-0014). Defaults are secure; every value is validated so a bad
 * override fails at startup instead of silently weakening security.
 */
export interface Argon2Params {
  /** Memory in KiB. */
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * Chosen from the benchmark in ADR-0014 (`npm run bench:password-hash`): 64 MiB, 4 passes, 1 lane,
 * median about 110 ms on the development machine, inside the 100-250 ms target.
 */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memoryCost: 65536,
  timeCost: 4,
  parallelism: 1,
};

/** OWASP minimum Argon2id configuration. Anything weaker is rejected by validateAuthConfig. */
export const MIN_ARGON2_PARAMS: Argon2Params = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
}

export interface LockoutPolicy {
  /** Consecutive failures that trigger a lock. */
  maxFailures: number;
  lockMinutes: number;
}

export interface SessionPolicy {
  /** Hard limit from creation; the session can never outlive it. */
  absoluteHours: number;
  /** Session is rejected if unused for this long. */
  idleMinutes: number;
  /** last_seen_at is written at most this often per session (limits write load). */
  touchIntervalSeconds: number;
}

export interface AuthConfig {
  argon2: Argon2Params;
  password: PasswordPolicy;
  lockout: LockoutPolicy;
  session: SessionPolicy;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  argon2: DEFAULT_ARGON2_PARAMS,
  password: { minLength: 12, maxLength: 128 },
  lockout: { maxFailures: 5, lockMinutes: 15 },
  session: { absoluteHours: 12, idleMinutes: 30, touchIntervalSeconds: 30 },
};

export type PartialAuthConfig = {
  [K in keyof AuthConfig]?: Partial<AuthConfig[K]>;
};

export class AuthConfigError extends Error {}

export function resolveAuthConfig(
  overrides: PartialAuthConfig = {},
  options: { allowWeakHashingForTests?: boolean } = {},
): AuthConfig {
  const cfg: AuthConfig = {
    argon2: { ...DEFAULT_AUTH_CONFIG.argon2, ...overrides.argon2 },
    password: { ...DEFAULT_AUTH_CONFIG.password, ...overrides.password },
    lockout: { ...DEFAULT_AUTH_CONFIG.lockout, ...overrides.lockout },
    session: { ...DEFAULT_AUTH_CONFIG.session, ...overrides.session },
  };
  validateAuthConfig(cfg, options);
  return cfg;
}

export function validateAuthConfig(
  cfg: AuthConfig,
  options: { allowWeakHashingForTests?: boolean } = {},
): void {
  const problems: string[] = [];
  const posInt = (name: string, v: number, min = 1) => {
    if (!Number.isInteger(v) || v < min) problems.push(`${name} must be an integer >= ${min}`);
  };
  posInt('argon2.memoryCost', cfg.argon2.memoryCost, 8);
  posInt('argon2.timeCost', cfg.argon2.timeCost);
  posInt('argon2.parallelism', cfg.argon2.parallelism);
  if (!options.allowWeakHashingForTests) {
    if (cfg.argon2.memoryCost < MIN_ARGON2_PARAMS.memoryCost)
      problems.push(`argon2.memoryCost must be >= ${MIN_ARGON2_PARAMS.memoryCost} KiB`);
    if (cfg.argon2.timeCost < MIN_ARGON2_PARAMS.timeCost)
      problems.push(`argon2.timeCost must be >= ${MIN_ARGON2_PARAMS.timeCost}`);
  }
  posInt('password.minLength', cfg.password.minLength, 8);
  posInt('password.maxLength', cfg.password.maxLength);
  if (cfg.password.maxLength < cfg.password.minLength || cfg.password.maxLength > 1024)
    problems.push('password.maxLength must be between minLength and 1024');
  posInt('lockout.maxFailures', cfg.lockout.maxFailures, 3);
  posInt('lockout.lockMinutes', cfg.lockout.lockMinutes);
  posInt('session.absoluteHours', cfg.session.absoluteHours);
  posInt('session.idleMinutes', cfg.session.idleMinutes);
  posInt('session.touchIntervalSeconds', cfg.session.touchIntervalSeconds, 0);
  if (cfg.session.idleMinutes > cfg.session.absoluteHours * 60)
    problems.push('session.idleMinutes must not exceed session.absoluteHours');
  if (problems.length > 0)
    throw new AuthConfigError(`Invalid auth configuration: ${problems.join('; ')}`);
}
