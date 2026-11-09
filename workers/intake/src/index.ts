import { buildLeadAlert, sendAlert } from './alert.ts';
import { createInboundLead, logActivity, SupabaseError } from './supabase.ts';
import { verifyTurnstile } from './turnstile.ts';
import type { Ctx, Env, EstimateRequest, IntakeResult } from './types.ts';
import { validateEstimateRequest } from './validate.ts';

const MAX_BODY_BYTES = 16 * 1024;

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = list(env.ALLOWED_ORIGINS);
  if (!origin || !allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function log(event: string, data: Record<string, unknown> = {}): void {
  // Structured logs for `wrangler tail`. Never log names, phones, emails or addresses.
  console.log(JSON.stringify({ event, ...data }));
}

async function notifyOwner(env: Env, req: EstimateRequest, result: IntakeResult, fetchFn: typeof fetch) {
  const email = buildLeadAlert(req, result);
  const sent = await sendAlert(env.RESEND_API_KEY, env.ALERT_FROM_EMAIL, env.ALERT_TO_EMAIL, email, req.intakeKey, fetchFn);
  if (sent.ok) {
    log('alert_sent', { lead_id: result.leadId });
  } else {
    log('alert_failed', { lead_id: result.leadId, status: sent.status, detail: sent.detail });
  }
  try {
    await logActivity(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      result.contactId,
      result.leadId,
      sent.ok ? 'Alert email sent to owner' : 'Alert email FAILED',
      sent.ok ? { channel: 'email', provider_id: sent.id } : { channel: 'email', status: sent.status, detail: sent.detail },
      fetchFn,
    );
  } catch {
    log('activity_log_failed', { lead_id: result.leadId });
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: Ctx,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  if (url.pathname === '/health') return json(200, { ok: true }, {});

  if (url.pathname !== '/v1/estimate-requests') return json(404, { ok: false, error: 'not_found' }, cors);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
  }
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, cors);

  if (!cors['Access-Control-Allow-Origin']) {
    log('origin_rejected', { origin });
    return json(403, { ok: false, error: 'origin_not_allowed' }, cors);
  }

  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) {
    return json(415, { ok: false, error: 'unsupported_media_type' }, cors);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, error: 'too_large' }, cors);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: 'invalid_json' }, cors);
  }

  const v = validateEstimateRequest(body);
  if (!v.ok) {
    if ('spam' in v) {
      log('honeypot_triggered');
      // Look successful so bots don't learn anything.
      return json(200, { ok: true }, cors);
    }
    return json(400, { ok: false, error: 'validation', fields: v.errors }, cors);
  }

  const ts = await verifyTurnstile(
    v.value.turnstileToken,
    env.TURNSTILE_SECRET_KEY,
    list(env.TURNSTILE_HOSTNAMES),
    request.headers.get('CF-Connecting-IP'),
    fetchFn,
  );
  if (!ts.success) {
    log('turnstile_failed', { codes: ts.errorCodes });
    return json(403, { ok: false, error: 'verification_failed' }, cors);
  }

  let result: IntakeResult;
  try {
    result = await createInboundLead(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, v.value, fetchFn);
  } catch (e) {
    const status = e instanceof SupabaseError ? e.status : 0;
    const code = e instanceof SupabaseError ? e.code : null;
    log('intake_failed', { status, code });
    // 22023 / 23514 = our own validation in the database
    if (code === '22023' || code === '23514') {
      return json(400, { ok: false, error: 'validation' }, cors);
    }
    return json(500, { ok: false, error: 'server_error' }, cors);
  }

  log('lead_created', { lead_id: result.leadId, duplicate: result.isDuplicate });

  if (!result.isDuplicate) {
    ctx.waitUntil(notifyOwner(env, v.value, result, fetchFn));
  }

  return json(200, { ok: true }, cors);
}

export default {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
