# Bonilla's Tree Services Platform

Lead capture, CRM and follow-up system for Bonilla's Tree Services (Waukegan, IL).

## Structure

```
supabase/
  migrations/   Database changes, applied in filename order. Never edit one
                that has already been applied to production; add a new file.
  tests/        SQL tests. local_supabase_stub.sql is for local Postgres only.
apps/           (coming) owner app and admin dashboard
workers/        (coming) Cloudflare Worker: form intake, alerts, cron jobs
```

## Migration 001: core CRM

Creates `profiles`, `lead_sources`, `contacts`, `properties`, `contact_consents`,
`leads`, `activities`, plus `create_inbound_lead()`.

- Anonymous visitors cannot read or write anything.
- The website form never touches the database directly. The Worker calls
  `create_inbound_lead()` with the service role key.
- Contacts are deduplicated by phone (E.164) and email (case-insensitive).
- Each form submission carries an `intake_key`; retries never create a second lead.
- Owner and admin see all business data. New sign-ups default to `crew`, which
  sees nothing yet. Only an admin can change roles.
- Contacts, leads, consents and the activity timeline cannot be hard-deleted from
  the app. Mark leads `lost` or `not_a_fit` instead.

## Apply to Supabase (first time)

1. Supabase dashboard -> your project -> **SQL Editor** -> New query.
2. Paste the full contents of `supabase/migrations/20261109000001_core_crm.sql`.
3. Run. It should finish with "Success. No rows returned."
4. Check **Table Editor**: 7 tables, each showing "RLS enabled".
5. **Authentication -> Users -> Add user**: create your account, then in
   SQL Editor run:
   ```sql
   update public.profiles set role = 'admin', full_name = 'Your Name'
   where id = (select id from auth.users where email = 'you@example.com');
   ```
6. Later, your father's account gets `role = 'owner'` and
   `preferred_language = 'es'`.

Do not run anything in `supabase/tests/` against Supabase.

## Run the tests locally (optional)

Requires PostgreSQL 15+.

```bash
createdb bonilla_test
psql -d bonilla_test -v ON_ERROR_STOP=1 -f supabase/tests/local_supabase_stub.sql
psql -d bonilla_test -v ON_ERROR_STOP=1 -f supabase/migrations/20261109000001_core_crm.sql
psql -d bonilla_test -v ON_ERROR_STOP=1 -f supabase/tests/core_crm_test.sql
# Expect: ALL TESTS PASSED
dropdb bonilla_test
```

## Secrets

Never commit keys. The Supabase **service_role** key goes only into Cloudflare
Worker secrets. The browser apps use the **anon/publishable** key.
