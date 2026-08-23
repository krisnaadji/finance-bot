/**
 * Minimal PII-safe logger.
 *
 * Goals:
 *   - Never write raw phone numbers, message text, or full request bodies.
 *   - Keep logs structured enough to be useful for debugging (ids, lengths,
 *     redacted tails) without leaking user data to Worker logs.
 *   - Respect LOG_LEVEL so noisy `debug` calls disappear in production.
 *
 * Levels (ascending): debug < info < warn < error.
 * Default level: `info` in production, `debug` otherwise.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

let cachedLevel: number | null = null;

// Resolved on first log call rather than at import: on Workers, process.env
// is not populated at module-eval time.
function activeLevel(): number {
  if (cachedLevel === null) cachedLevel = LEVELS[resolveLevel()];
  return cachedLevel;
}

// ── Redaction helpers ────────────────────────────────────────────────

/**
 * Mask all but the first 3 and last 4 characters of a phone number.
 *   "628123456789" → "628*****6789"
 * Non-string / short values fall back to a fixed placeholder so we never
 * accidentally echo something like `null`+`phone-like-suffix`.
 */
export function redactPhone(phone: string | null | undefined): string {
  if (!phone || typeof phone !== 'string') return '<none>';
  if (phone.length <= 7) return '<short>';
  return phone.slice(0, 3) + '*****' + phone.slice(-4);
}

/**
 * Replace free-form text with a length-only summary so we never write the
 * user's actual message body to logs.
 */
export function redactText(text: string | null | undefined): string {
  if (text == null) return '<none>';
  if (typeof text !== 'string') return '<non-string>';
  return '<' + text.length + ' chars>';
}

/**
 * Summarize an IncomingMessage without leaking its content.
 * Keeps: messageId, redacted chatId/rawFrom, textLength, hasReply.
 */
export function safeSummarizeMsg(msg: {
  messageId?: string;
  chatId?: string;
  rawFrom?: string;
  text?: string | null;
  repliedToId?: string | null;
}): Record<string, unknown> {
  return {
    messageId: msg.messageId,
    chatId: redactPhone(msg.chatId),
    rawFrom: redactPhone(msg.rawFrom),
    textLength: typeof msg.text === 'string' ? msg.text.length : 0,
    hasReply: !!msg.repliedToId,
  };
}

/**
 * Reduce an Error to safe fields. Avoid passing the raw error object into
 * console/JSON — custom error subclasses (e.g. from supabase-js) can stash
 * query payloads or request bodies on their properties.
 */
function scrubError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: String(err) };
}

// ── Core log function ────────────────────────────────────────────────

function log(level: Level, scope: string, event: string, data?: unknown): void {
  if (LEVELS[level] < activeLevel()) return;

  const payload: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    event,
  };

  if (data !== undefined) {
    payload.data = data instanceof Error ? scrubError(data) : data;
  }

  // Route warn/error to stderr; info/debug to stdout. wrangler tail surfaces both.
  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Log an error with optional structured context.
 *
 * `err` should ideally be an Error (its scrubbed stack is included); if it
 * isn't one, `String(err)` is captured under `value`. `context` is any
 * extra scrubbed data — UUIDs, enums, redacted phones — that helps
 * diagnose the failure.
 */
function logError(
  scope: string,
  event: string,
  err?: unknown,
  context?: Record<string, unknown>,
): void {
  const hasErr = err !== undefined;
  const scrubbed = hasErr
    ? err instanceof Error
      ? scrubError(err)
      : { value: String(err) }
    : undefined;

  const data: Record<string, unknown> | undefined = hasErr
    ? context
      ? { ...context, err: scrubbed }
      : { err: scrubbed }
    : context;

  log('error', scope, event, data);
}

export const logger = {
  debug: (scope: string, event: string, data?: unknown) => log('debug', scope, event, data),
  info: (scope: string, event: string, data?: unknown) => log('info', scope, event, data),
  warn: (scope: string, event: string, data?: unknown) => log('warn', scope, event, data),
  error: (scope: string, event: string, err?: unknown, context?: Record<string, unknown>) =>
    logError(scope, event, err, context),
};
