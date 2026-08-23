import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyFonnteToken, verifyMetaSignature } from '../src/utils/webhookAuth';

const SECRET = 'test-app-secret';
const BODY = '{"entry":[{"id":"1"}]}';

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyMetaSignature', () => {
  it('accepts a genuine signature over a string body', () => {
    expect(verifyMetaSignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  it('rejects a signature computed over different bytes', () => {
    expect(verifyMetaSignature(BODY, sign(BODY + ' ', SECRET), SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyMetaSignature(BODY, sign(BODY, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifyMetaSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, 'sha1=abc', SECRET)).toBe(false);
  });
});

describe('verifyFonnteToken', () => {
  it('accepts a matching x-fonnte-token header', () => {
    const headers = new Headers({ 'x-fonnte-token': 'shared-secret' });
    expect(verifyFonnteToken(headers, 'shared-secret')).toBe(true);
  });

  it('accepts a Bearer-prefixed authorization header', () => {
    const headers = new Headers({ authorization: 'Bearer shared-secret' });
    expect(verifyFonnteToken(headers, 'shared-secret')).toBe(true);
  });

  it('rejects a mismatched token', () => {
    const headers = new Headers({ 'x-fonnte-token': 'wrong-secret!' });
    expect(verifyFonnteToken(headers, 'shared-secret')).toBe(false);
  });

  it('fails closed when no expected token is configured', () => {
    const headers = new Headers({ 'x-fonnte-token': 'anything' });
    expect(verifyFonnteToken(headers, undefined)).toBe(false);
  });
});
