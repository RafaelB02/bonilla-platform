import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLeadAlert, escapeHtml } from '../src/alert.ts';
import { handleRequest } from '../src/index.ts';
import { toRpcArgs } from '../src/supabase.ts';
import type { Env } from '../src/types.ts';
import { normalizeUsPhone, validateEstimateRequest } from '../src/validate.ts';

const ORIGIN = 'https://bonillastreeservices.com';

const env: Env = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
  TURNSTILE_SECRET_KEY: 'ts_secret',
  RESEND_API_KEY: 're_test',
  ALERT_TO_EMAIL: 'owner@example.com',
  ALERT_FROM_EMAIL: 'Bonilla Leads <onboarding@resend.dev>',
  ALLOWED_ORIGINS: `${ORIGIN},https://www.bonillastreeservices.com`,
  TURNSTILE_HOSTNAMES: 'bonillastreeservices.com,www.bonillastreeservices.com',
};

function validBody(over: Record<string, unknown> = {}) {
  return {
    intake_key: '3f1c2b9e-1111-4a2b-9c3d-000000000001',
    name: '  Maria   Lopez ',
    phone: '(847) 555-0101',
    email: 'Maria@Example.com',
    address: '123 Main St',
    city: 'Waukegan',
    zip: '60085',
    service: 'tree_removal',
    lead_type: 'residential',
    description: 'Dead ash <b>leaning</b> toward garage',
    urgent: true,
    language: 'es',
    sms_consent: true,
    consent_text: 'You may text me about this request.',
    turnstile_token: 'token-abcdefghijk',
    company_website: '',
    ...over,
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(opts: {
  turnstile?: Record<string, unknown>;
  rpcStatus?: number;
  rpcBody?: unknown;
  resendStatus?: number;
} = {}) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('turnstile')) {
      return Response.json(opts.turnstile ?? { success: true, hostname: 'bonillastreeservices.com' });
    }
    if (url.includes('/rpc/create_inbound_lead')) {
      return Response.json(
        opts.rpcBody ?? [{ lead_id: 'lead-1', contact_id: 'contact-1', is_duplicate: false }],
        { status: opts.rpcStatus ?? 200 },
      );
    }
    if (url.includes('api.resend.com')) {
      return Response.json(
        opts.resendStatus && opts.resendStatus >= 400 ? { name: 'validation_error' } : { id: 'email-1' },
        { status: opts.resendStatus ?? 200 },
      );
    }
    if (url.includes('/rest/v1/activities')) return new Response(null, { status: 201 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { fn, calls };
}

function ctx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    flush: () => Promise.all(pending),
  };
}

function post(body: unknown, origin: string | null = ORIGIN, contentType = 'application/json') {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (origin) headers.Origin = origin;
  return new Request('https://intake.example.workers.dev/v1/estimate-requests', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// ---------------- validation ----------------

test('phone normalization matches the database function', () => {
  assert.equal(normalizeUsPhone('(847) 409-1584'), '+18474091584');
  assert.equal(normalizeUsPhone('1-847-409-1584'), '+18474091584');
  assert.equal(normalizeUsPhone('12345'), null);
  assert.equal(normalizeUsPhone('(147) 409-1584'), null);
});

test('valid body is normalized', () => {
  const v = validateEstimateRequest(validBody());
  assert.ok(v.ok);
  assert.equal(v.value.fullName, 'Maria Lopez');
  assert.equal(v.value.phoneE164, '+18475550101');
  assert.equal(v.value.email, 'maria@example.com');
  assert.equal(v.value.smsConsent, true);
});

test('field errors are reported', () => {
  const v = validateEstimateRequest(validBody({ phone: '123', email: 'nope', zip: '6008', name: '', address: '' }));
  assert.ok(!v.ok && 'errors' in v);
  assert.deepEqual(Object.keys(v.errors).sort(), ['address', 'email', 'name', 'phone', 'zip']);
});

test('phone or email is required', () => {
  const v = validateEstimateRequest(validBody({ phone: '', email: '' }));
  assert.ok(!v.ok && 'errors' in v && v.errors.phone === 'phone_or_email_required');
});

test('email only is fine; sms consent dropped without a phone', () => {
  const v = validateEstimateRequest(validBody({ phone: '' }));
  assert.ok(v.ok);
  assert.equal(v.value.phoneE164, null);
  assert.equal(v.value.smsConsent, false);
  assert.equal(v.value.consentText, null);
});

test('unknown service is rejected, missing service defaults to other', () => {
  const bad = validateEstimateRequest(validBody({ service: 'pool_cleaning' }));
  assert.ok(!bad.ok && 'errors' in bad && bad.errors.service === 'invalid');
  const { service: _s, ...rest } = validBody();
  const def = validateEstimateRequest(rest);
  assert.ok(def.ok && def.value.serviceType === 'other');
});

test('long description is truncated, control characters stripped', () => {
  const v = validateEstimateRequest(validBody({ description: 'a\u0000b' + 'x'.repeat(3000) }));
  assert.ok(v.ok);
  assert.equal(v.value.description!.length, 2000);
  assert.ok(v.value.description!.startsWith('ab'));
});

test('honeypot is flagged as spam', () => {
  const v = validateEstimateRequest(validBody({ company_website: 'http://spam.example' }));
  assert.ok(!v.ok && 'spam' in v);
});

test('non-object bodies are rejected', () => {
  for (const b of [null, 'x', 42, []]) {
    const v = validateEstimateRequest(b);
    assert.ok(!v.ok && 'errors' in v);
  }
});

// ---------------- RPC contract ----------------

test('RPC argument names match create_inbound_lead()', () => {
  const v = validateEstimateRequest(validBody());
  assert.ok(v.ok);
  assert.deepEqual(Object.keys(toRpcArgs(v.value)), [
    'p_intake_key', 'p_full_name', 'p_phone', 'p_email', 'p_language',
    'p_address_line1', 'p_city', 'p_zip', 'p_service_type', 'p_lead_type',
    'p_description', 'p_is_urgent', 'p_source_code', 'p_sms_consent', 'p_consent_text',
  ]);
});

// ---------------- alert email ----------------

test('alert is Spanish, escapes HTML, links phone and map', () => {
  const v = validateEstimateRequest(validBody());
  assert.ok(v.ok);
  const a = buildLeadAlert(v.value, { leadId: 'lead-1', contactId: 'c', isDuplicate: false });
  assert.equal(a.subject, 'URGENTE: Nuevo cliente: Maria Lopez - Quitar árbol (Waukegan)');
  assert.ok(a.html.includes('href="tel:+18475550101"'));
  assert.ok(a.html.includes('(847) 555-0101'));
  assert.ok(a.html.includes('google.com/maps/search'));
  assert.ok(a.html.includes('&lt;b&gt;leaning&lt;/b&gt;'));
  assert.ok(!a.html.includes('<b>leaning</b>'));
  assert.ok(a.text.includes('Teléfono: (847) 555-0101 (acepta textos)'));
});

test('escapeHtml covers quotes', () => {
  assert.equal(escapeHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
});

// ---------------- handler ----------------

test('happy path saves lead, then sends one alert and logs it', async () => {
  const f = fakeFetch();
  const c = ctx();
  const res = await handleRequest(post(validBody()), env, c, f.fn);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  await c.flush();

  const urls = f.calls.map((x) => new URL(x.url).hostname + new URL(x.url).pathname);
  assert.deepEqual(urls, [
    'challenges.cloudflare.com/turnstile/v0/siteverify',
    'proj.supabase.co/rest/v1/rpc/create_inbound_lead',
    'api.resend.com/emails',
    'proj.supabase.co/rest/v1/activities',
  ]);

  const rpc = f.calls[1]!;
  const h = rpc.init.headers as Record<string, string>;
  assert.equal(h.apikey, 'sb_secret_test');
  assert.equal(h.Authorization, undefined, 'new secret keys are not sent as Bearer');

  const resend = f.calls[2]!;
  const rh = resend.init.headers as Record<string, string>;
  assert.equal(rh['Idempotency-Key'], 'lead-alert/3f1c2b9e-1111-4a2b-9c3d-000000000001');
  assert.deepEqual(JSON.parse(String(resend.init.body)).to, ['owner@example.com']);
});

test('legacy JWT service key is also sent as Bearer', async () => {
  const f = fakeFetch();
  await handleRequest(post(validBody()), { ...env, SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOi.x.y' }, ctx(), f.fn);
  const h = f.calls[1]!.init.headers as Record<string, string>;
  assert.equal(h.Authorization, 'Bearer eyJhbGciOi.x.y');
});

test('duplicate submission sends no second alert', async () => {
  const f = fakeFetch({ rpcBody: [{ lead_id: 'lead-1', contact_id: 'c', is_duplicate: true }] });
  const c = ctx();
  const res = await handleRequest(post(validBody()), env, c, f.fn);
  await c.flush();
  assert.equal(res.status, 200);
  assert.ok(!f.calls.some((x) => x.url.includes('resend')));
});

test('alert failure still returns success and is logged on the lead', async () => {
  const f = fakeFetch({ resendStatus: 422 });
  const c = ctx();
  const res = await handleRequest(post(validBody()), env, c, f.fn);
  await c.flush();
  assert.equal(res.status, 200);
  const act = f.calls.find((x) => x.url.includes('/activities'))!;
  assert.equal(JSON.parse(String(act.init.body)).body, 'Alert email FAILED');
});

test('failed Turnstile is rejected before touching the database', async () => {
  const f = fakeFetch({ turnstile: { success: false, 'error-codes': ['timeout-or-duplicate'] } });
  const res = await handleRequest(post(validBody()), env, ctx(), f.fn);
  assert.equal(res.status, 403);
  assert.equal(f.calls.length, 1);
});

test('Turnstile token from another hostname is rejected', async () => {
  const f = fakeFetch({ turnstile: { success: true, hostname: 'evil.example' } });
  const res = await handleRequest(post(validBody()), env, ctx(), f.fn);
  assert.equal(res.status, 403);
});

test('honeypot returns fake success and calls nothing', async () => {
  const f = fakeFetch();
  const res = await handleRequest(post(validBody({ company_website: 'x' })), env, ctx(), f.fn);
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 0);
});

test('validation errors return 400 with fields and call nothing', async () => {
  const f = fakeFetch();
  const res = await handleRequest(post(validBody({ zip: 'abc' })), env, ctx(), f.fn);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { fields: Record<string, string> };
  assert.equal(body.fields.zip, 'invalid');
  assert.equal(f.calls.length, 0);
});

test('disallowed origin, missing origin, wrong content type, bad JSON, big body', async () => {
  const f = fakeFetch();
  assert.equal((await handleRequest(post(validBody(), 'https://evil.example'), env, ctx(), f.fn)).status, 403);
  assert.equal((await handleRequest(post(validBody(), null), env, ctx(), f.fn)).status, 403);
  assert.equal((await handleRequest(post('a=b', ORIGIN, 'application/x-www-form-urlencoded'), env, ctx(), f.fn)).status, 415);
  assert.equal((await handleRequest(post('{nope', ORIGIN), env, ctx(), f.fn)).status, 400);
  const big = JSON.stringify(validBody({ description: 'x'.repeat(20000) }));
  assert.equal((await handleRequest(post(big, ORIGIN), env, ctx(), f.fn)).status, 413);
  assert.equal(f.calls.length, 0);
});

test('database validation error maps to 400, other errors to 500', async () => {
  const v = fakeFetch({ rpcStatus: 400, rpcBody: { code: '22023', message: 'invalid phone number' } });
  assert.equal((await handleRequest(post(validBody()), env, ctx(), v.fn)).status, 400);
  const e = fakeFetch({ rpcStatus: 503, rpcBody: { message: 'down' } });
  const res = await handleRequest(post(validBody()), env, ctx(), e.fn);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: 'server_error' });
});

test('CORS preflight', async () => {
  const ok = await handleRequest(
    new Request('https://x/v1/estimate-requests', { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
    env, ctx(), fakeFetch().fn,
  );
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  const bad = await handleRequest(
    new Request('https://x/v1/estimate-requests', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }),
    env, ctx(), fakeFetch().fn,
  );
  assert.equal(bad.status, 403);
});

test('other routes and methods', async () => {
  const f = fakeFetch().fn;
  assert.equal((await handleRequest(new Request('https://x/health'), env, ctx(), f)).status, 200);
  assert.equal((await handleRequest(new Request('https://x/nope'), env, ctx(), f)).status, 404);
  assert.equal(
    (await handleRequest(new Request('https://x/v1/estimate-requests', { headers: { Origin: ORIGIN } }), env, ctx(), f)).status,
    405,
  );
});

test('logs never contain personal data', async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  try {
    const c = ctx();
    await handleRequest(post(validBody()), env, c, fakeFetch().fn);
    await c.flush();
  } finally {
    console.log = orig;
  }
  const all = lines.join('\n');
  for (const pii of ['Maria', '555', 'example.com', 'Main St']) {
    assert.ok(!all.includes(pii), `log leaked ${pii}`);
  }
});
