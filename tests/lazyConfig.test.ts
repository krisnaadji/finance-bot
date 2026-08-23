/**
 * Cloudflare Workers only exposes configuration during request handling, not
 * at module-evaluation time. These tests pin the two modules that used to
 * read process.env at import.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('supabase client', () => {
  it('imports without throwing when config is missing', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_KEY', '');

    await expect(import('../src/services/supabase')).resolves.toBeTruthy();
  });

  it('throws on first use when config is missing', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_KEY', '');

    const { supabase } = await import('../src/services/supabase');
    expect(() => supabase.from('accounts')).toThrow(/SUPABASE_URL/);
  });

  it('builds a usable client when config is present', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key');

    const { supabase } = await import('../src/services/supabase');
    // `from` must be callable and keep its receiver — an unbound method
    // would throw here.
    expect(typeof supabase.from('accounts').select).toBe('function');
  });
});

describe('logger level', () => {
  it('resolves LOG_LEVEL at call time, not import time', async () => {
    vi.stubEnv('LOG_LEVEL', 'error');
    const { logger } = await import('../src/utils/logger');

    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.info('test', 'suppressed');
    logger.error('test', 'emitted');

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
  });
});
