# bonilla-intake (Cloudflare Worker)

Receives the website estimate form, saves the lead in Supabase, and emails the
owner. Endpoint: `POST /v1/estimate-requests`. Health check: `GET /health`.

## Flow

1. Rejects anything not from an allowed origin (`ALLOWED_ORIGINS`).
2. Validates and normalizes the input (`src/validate.ts`). A filled honeypot
   field returns a fake success and stops.
3. Verifies the Cloudflare Turnstile token, including that it was issued for
   our hostname.
4. Calls `public.create_inbound_lead()` with the Supabase secret key. The
   database deduplicates contacts and ignores repeated `intake_key`s.
5. For new leads only, sends a Spanish alert email through Resend (with an
   idempotency key) and writes "Alert email sent/FAILED" to the lead timeline.
   This runs after the response, so the customer never waits on email.

Logs never include names, phones, emails or addresses.

## Settings

| Name | Kind | Where to find it |
| --- | --- | --- |
| `SUPABASE_URL` | var in `wrangler.toml` | Supabase -> Project Settings -> Data API -> Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | Supabase -> Project Settings -> API Keys -> Secret key (`sb_secret_...`) |
| `TURNSTILE_SECRET_KEY` | **secret** | Cloudflare -> Turnstile -> bonilla-estimate-form -> Secret key |
| `RESEND_API_KEY` | **secret** | Resend -> API Keys |
| `ALERT_TO_EMAIL` | var | bonillastreeservice@gmail.com |
| `ALERT_FROM_EMAIL` | var | `onboarding@resend.dev` until the domain is verified in Resend |
| `ALLOWED_ORIGINS` | var | Site origins that host the form |
| `TURNSTILE_HOSTNAMES` | var | Hostnames Turnstile tokens must match |

The Supabase secret key bypasses row level security. It must only ever live in
Worker secrets: never in the form, the repo, or chat.

## Deploy (first time)

Requires Node.js 22.18 or newer.

```bash
cd workers/intake
npm install
npx wrangler login            # opens Cloudflare in the browser
# 1. Put your Supabase Project URL in wrangler.toml (SUPABASE_URL)
npx wrangler deploy           # prints https://bonilla-intake.bonillastreeservices.workers.dev
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put RESEND_API_KEY
curl https://bonilla-intake.bonillastreeservices.workers.dev/health   # {"ok":true}
```

Then set `WORKER_URL` in `apps/website-form/estimate-form.html` to
`https://bonilla-intake.bonillastreeservices.workers.dev/v1/estimate-requests`.

## Test

```bash
npm test          # 25 unit tests, no network needed
npm run typecheck
npx wrangler tail # live logs while you submit a test request
```

## Later

- Verify `bonillastreeservices.com` in Resend, then change `ALERT_FROM_EMAIL`
  to something like `Bonilla Leads <alerts@bonillastreeservices.com>`.
- Photo uploads (Supabase Storage) and the owner app come next.
