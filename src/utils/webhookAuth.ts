import crypto from 'crypto';

import { Request } from 'express';

/**
 * Verify the `X-Hub-Signature-256` header sent by Meta Cloud API.
 *
 * Meta signs the raw request body with your app's secret using HMAC-SHA256
 * and sends the result as `sha256=<hex>`. We recompute the HMAC on our side
 * and compare using a timing-safe comparison to avoid leaking info via
 * response-time differences.
 *
 * Docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
 */
export function verifyMetaSignature(
  rawBody: Buffer | string | undefined,
  signatureHeader: string | string[] | undefined,
  appSecret: string,
): boolean {
  if (!rawBody || !signatureHeader || !appSecret) return false;

  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!header.startsWith('sha256=')) return false;

  const received = header.slice('sha256='.length);

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = crypto.createHmac('sha256', appSecret).update(body).digest('hex');

  // Buffers must match length for timingSafeEqual; bail early if not.
  if (expected.length !== received.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify an optional shared-secret header for Fonnte.
 *
 * Fonnte doesn't sign webhook payloads like Meta does. The recommended
 * mitigation is to configure Fonnte to send a custom HTTP header with a
 * secret you control (e.g. `X-Fonnte-Token: <secret>`), and then verify it
 * here. If FONNTE_WEBHOOK_TOKEN is not set, verification is skipped (the
 * caller decides whether to fail closed or open in that case).
 */
export function verifyFonnteToken(req: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false; // caller should fail closed when secret missing
  const header = req.get('x-fonnte-token') ?? req.get('authorization') ?? '';
  // Strip optional "Bearer " prefix some integrations add.
  const received = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  if (!received || received.length !== expectedToken.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expectedToken));
  } catch {
    return false;
  }
}
