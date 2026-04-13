export const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes cap
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Built-in timeout defaults by step name.
 * QA test generation and engineer implementation get longer timeouts
 * because they produce significantly more output.
 */
export const STEP_TIMEOUT_DEFAULTS: Record<string, number> = {
  "Write tests": 15 * 60 * 1000,           // 15 min — BDD + integration + performance tests
  "Implement (TDD)": 10 * 60 * 1000,       // 10 min — read artifacts + write code + run tests
  "Architecture design": 7 * 60 * 1000,    // 7 min — read spec + produce design doc
  "Collect retro proposals": 5 * 60 * 1000, // 5 min — 4 agents in sequence
};

export interface TimeoutConfig {
  default?: number;
  stepOverrides?: Record<string, number>;
}

/**
 * Resolve the timeout for a given step name.
 *
 * Resolution order:
 * 1. Config stepOverrides[stepName] (if present and valid)
 * 2. Config default (if present and valid)
 * 3. STEP_TIMEOUT_DEFAULTS[stepName] (built-in per-step default)
 * 4. DEFAULT_TIMEOUT_MS (global fallback)
 *
 * Validation: timeout must be > 0 and <= MAX_TIMEOUT_MS.
 * Values > MAX_TIMEOUT_MS are capped. Values <= 0 fall through.
 */
export function resolveStepTimeout(stepName: string, config?: TimeoutConfig): number {
  // 1. Config step override
  if (config?.stepOverrides?.[stepName] !== undefined) {
    const val = config.stepOverrides[stepName];
    if (val > 0 && val <= MAX_TIMEOUT_MS) return val;
    if (val > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
    // Invalid (0 or negative) → fall through
  }

  // 2. Config default
  if (config?.default !== undefined) {
    const val = config.default;
    if (val > 0 && val <= MAX_TIMEOUT_MS) return val;
    if (val > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  }

  // 3. Built-in step default
  if (STEP_TIMEOUT_DEFAULTS[stepName] !== undefined) {
    return STEP_TIMEOUT_DEFAULTS[stepName];
  }

  // 4. Global fallback
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Format a timeout for display in the progress table.
 * Returns null if the timeout is the default (5 min).
 */
export function formatTimeoutDisplay(timeoutMs: number): string | null {
  if (timeoutMs === DEFAULT_TIMEOUT_MS) return null;
  const minutes = Math.round(timeoutMs / 60000);
  return `${minutes}min timeout`;
}
