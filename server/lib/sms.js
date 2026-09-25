'use strict';
// SMS phone verification. Providers (config.sms.provider / SMS_PROVIDER):
//   none    — disabled. Reports are still accepted and simply marked unverified.
//   console — development only: the code is written to the server log (never the phone number) and echoed back
//             as `devCode` so tests and local builds can complete the flow. Treated as disabled in production.
//   twilio  — Twilio Programmable Messaging REST API via fetch (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
//             TWILIO_FROM; TWILIO_FROM may be a sender number or a Messaging Service SID "MG…").
//
// IMPORTANT: verification only proves that the person could receive an SMS on that number at that moment.
// It does NOT prove that a report is true, and it is never used to auto-accept or auto-reject anything.
//
//   startVerification(e164, { ipSubject }) → { enabled, sent, expiresInSec, devCode?, message }
//   confirmVerification(e164, code)        → { verified: true, token, expiresInSec, message }
//   checkToken(e164, token)                → true | false   (valid 30 minutes after confirmation)
//   smsStatus()                            → { enabled, provider }
//
// Codes: 6 digits, stored only as a keyed hash, expire after 10 minutes, 5 attempts. Requesting a new code
// invalidates earlier unused ones. Tokens are random, stored as sha256, and live 30 minutes; once a row is
// verified its `expires_at` is re-used as the token expiry.
const crypto = require('node:crypto');
const config = require('../config');
const { getDb } = require('./db');
const { HttpError } = require('./http');
const { hashPhone, hashSubject, randomToken, sha256 } = require('./crypto');
const { rateCheck, rateRecord } = require('./ratelimit');
const { nowIso } = require('./time');

const CODE_TTL_SEC = 10 * 60;
const TOKEN_TTL_SEC = 30 * 60;
const MAX_ATTEMPTS = 5;
const LIMITS = {
  perPhoneCooldown: { windowMs: 60e3, max: 1 },
  perPhoneDay: { windowMs: 24 * 3600e3, max: 5 },
  perIpHour: { windowMs: 3600e3, max: 20 }, // guards against SMS pumping across many numbers
  confirmPerIpHour: { windowMs: 3600e3, max: 30 },
};

const PROOF_NOTE = 'Verification only shows that you can receive SMS on this number. It does not confirm what a report says.';

function smsStatus() {
  const s = config.sms;
  // In production a console "SMS" would only reach the server log, so nobody could verify: treat it as disabled.
  if (s.provider === 'console') return { enabled: !config.isProduction, provider: 'console' };
  if (s.provider === 'twilio') return { enabled: Boolean(s.twilioSid && s.twilioToken && s.twilioFrom), provider: 'twilio' };
  return { enabled: false, provider: 'none' };
}

const codeHash = (phoneHash, createdAt, code) => hashSubject(`otp|${phoneHash}|${createdAt}|${code}`, { rotateDaily: false });

function limited(result, message) {
  if (!result.allowed) throw new HttpError(429, 'rate_limited', message, { retryAfterSec: result.retryAfterSec });
}

async function sendViaTwilio(to, body) {
  const { twilioSid, twilioToken, twilioFrom } = config.sms;
  const params = new URLSearchParams({ To: to, Body: body });
  if (/^MG[0-9a-f]{32}$/i.test(twilioFrom)) params.set('MessagingServiceSid', twilioFrom);
  else params.set('From', twilioFrom);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
      signal: AbortSignal.timeout(10e3),
    });
    if (res.ok) return true;
    let code = '';
    try { code = (await res.json()).code || ''; } catch { /* ignore */ }
    // Log only the HTTP status and Twilio error code: Twilio messages can echo the destination number.
    console.error('[sms] twilio send failed', res.status, code);
    return false;
  } catch (err) {
    console.error('[sms] twilio unreachable:', err.name);
    return false;
  }
}

async function startVerification(e164, { ipSubject = 'unknown', lang = 'en' } = {}) {
  const status = smsStatus();
  if (!status.enabled) {
    return {
      enabled: false, sent: false, expiresInSec: 0,
      message: 'Phone verification is not available right now. You can still send a report; it will be marked as unverified.',
    };
  }
  const phoneHash = hashPhone(e164);
  limited(rateCheck('sms:ip', ipSubject, LIMITS.perIpHour), 'Too many verification requests from this connection. Please try again later.');
  limited(rateCheck('sms:phone', phoneHash, LIMITS.perPhoneCooldown), 'Please wait a minute before requesting another code.');
  limited(rateCheck('sms:phone-day', phoneHash, LIMITS.perPhoneDay), 'Too many codes requested for this number today. Please try again tomorrow.');

  const db = getDb();
  const now = nowIso();
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  // Only the newest code is valid.
  db.prepare('UPDATE phone_verifications SET expires_at = ? WHERE phone_hash = ? AND verified_at IS NULL AND expires_at > ?').run(now, phoneHash, now);
  const expiresAt = new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString();
  const row = db.prepare('INSERT INTO phone_verifications (phone_hash, code_hash, attempts, expires_at, created_at) VALUES (?, ?, 0, ?, ?)')
    .run(phoneHash, codeHash(phoneHash, now, code), expiresAt, now);
  rateRecord('sms:ip', ipSubject);
  rateRecord('sms:phone', phoneHash);
  rateRecord('sms:phone-day', phoneHash);

  const body = lang === 'ur'
    ? `ٹیم واٹر تصدیقی کوڈ: ${code} — یہ 10 منٹ میں ختم ہو جائے گا۔ کسی کو نہ بتائیں۔`
    : `Team Water verification code: ${code}. It expires in 10 minutes. Do not share it.`;
  let sent;
  if (status.provider === 'console') {
    // Never log the phone number — only the verification row id and the code.
    console.log(`[sms:console] verification #${row.lastInsertRowid} code ${code} (expires in 10 min)`);
    sent = true;
  } else {
    sent = await sendViaTwilio(e164, body);
  }
  if (!sent) {
    db.prepare('UPDATE phone_verifications SET expires_at = ? WHERE id = ?').run(nowIso(), row.lastInsertRowid);
    return { enabled: true, sent: false, expiresInSec: 0, message: 'We could not send the SMS right now. You can still send your report; it will be marked as unverified.' };
  }
  const out = { enabled: true, sent: true, expiresInSec: CODE_TTL_SEC, message: `Code sent. ${PROOF_NOTE}` };
  if (status.provider === 'console' && !config.isProduction) out.devCode = code; // console is never enabled in production anyway
  return out;
}

function confirmVerification(e164, code, { ipSubject = 'unknown' } = {}) {
  if (!smsStatus().enabled) throw new HttpError(409, 'verification_unavailable', 'Phone verification is not available right now.');
  limited(rateCheck('sms:confirm-ip', ipSubject, LIMITS.confirmPerIpHour), 'Too many attempts from this connection. Please try again later.');
  rateRecord('sms:confirm-ip', ipSubject);
  const db = getDb();
  const phoneHash = hashPhone(e164);
  const now = nowIso();
  const row = db.prepare(`SELECT * FROM phone_verifications WHERE phone_hash = ? AND verified_at IS NULL AND expires_at > ?
                          ORDER BY created_at DESC, id DESC LIMIT 1`).get(phoneHash, now);
  if (!row) throw new HttpError(400, 'code_expired', 'This code has expired or was already used. Please request a new code.', { field: 'code' });
  if (row.attempts >= MAX_ATTEMPTS) {
    db.prepare('UPDATE phone_verifications SET expires_at = ? WHERE id = ?').run(now, row.id);
    throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Please request a new code.', { field: 'code', retryAfterSec: 60 });
  }
  const expected = Buffer.from(row.code_hash);
  const actual = Buffer.from(codeHash(phoneHash, row.created_at, String(code || '').trim()));
  const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!ok) {
    const attempts = row.attempts + 1;
    db.prepare('UPDATE phone_verifications SET attempts = ?, expires_at = CASE WHEN ? >= ? THEN ? ELSE expires_at END WHERE id = ?')
      .run(attempts, attempts, MAX_ATTEMPTS, now, row.id);
    if (attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Please request a new code.', { field: 'code', retryAfterSec: 60 });
    throw new HttpError(400, 'invalid_code', 'That code is not correct.', { field: 'code', attemptsRemaining: MAX_ATTEMPTS - attempts });
  }
  const token = randomToken(24);
  db.prepare('UPDATE phone_verifications SET verified_at = ?, token_hash = ?, attempts = ?, expires_at = ? WHERE id = ?')
    .run(now, sha256(token), row.attempts + 1, new Date(Date.now() + TOKEN_TTL_SEC * 1000).toISOString(), row.id);
  return { verified: true, token, expiresInSec: TOKEN_TTL_SEC, message: `Phone verified. ${PROOF_NOTE}` };
}

/** True when `token` was issued for this phone within the last 30 minutes. */
function checkToken(e164, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return false;
  const row = getDb()
    .prepare('SELECT id FROM phone_verifications WHERE token_hash = ? AND phone_hash = ? AND verified_at IS NOT NULL AND expires_at > ?')
    .get(sha256(token), hashPhone(e164), nowIso());
  return Boolean(row);
}

/** Convenience for GET /api/config → sms.enabled. */
const isEnabled = () => smsStatus().enabled;

module.exports = { smsStatus, isEnabled, startVerification, confirmVerification, checkToken, PROOF_NOTE, CODE_TTL_SEC, TOKEN_TTL_SEC, MAX_ATTEMPTS };
