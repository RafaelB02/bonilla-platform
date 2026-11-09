-- =====================================================================
-- Bonilla's Tree Services - Migration 001: core CRM (Phase 1)
-- Tables: profiles, lead_sources, contacts, properties,
--         contact_consents, leads, activities
-- Function: create_inbound_lead() - the ONLY way public form
--           submissions enter the database (called by the Worker).
-- Safe to run on an empty Supabase project. Non-destructive.
-- =====================================================================

-- ---------- Enums ----------------------------------------------------
create type public.app_role       as enum ('owner', 'admin', 'crew');
create type public.app_language   as enum ('es', 'en');
create type public.lead_stage     as enum (
  'new', 'contacted', 'estimate_scheduled', 'estimate_sent', 'won', 'lost', 'not_a_fit'
);
create type public.lead_type      as enum ('residential', 'commercial');
create type public.service_type   as enum (
  'tree_removal', 'tree_trimming', 'stump_grinding', 'storm_damage', 'other'
);
create type public.contact_channel as enum ('call', 'sms', 'email');
create type public.consent_purpose as enum ('transactional', 'marketing');
create type public.activity_type  as enum (
  'note', 'call', 'sms', 'email', 'stage_change', 'form_submission', 'system'
);

-- ---------- Shared helpers ------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Normalize a US phone number to E.164 (+1XXXXXXXXXX). Returns null if invalid.
create or replace function public.normalize_us_phone(raw text)
returns text language sql immutable as $$
  select case
    when d ~ '^1[2-9][0-9]{9}$' then '+' || d
    when d ~ '^[2-9][0-9]{9}$'  then '+1' || d
    else null
  end
  from (select regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g') as d) s
$$;

-- ---------- Profiles (app users) ------------------------------------
create table public.profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  full_name          text not null default '',
  role               public.app_role not null default 'crew',
  preferred_language public.app_language not null default 'es',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Role lookups used by RLS. SECURITY DEFINER avoids recursive RLS on profiles.
create or replace function public.current_app_role()
returns public.app_role language sql stable security definer
set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer
set search_path = public as $$
  select coalesce(public.current_app_role() in ('owner', 'admin'), false)
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public as $$
  select coalesce(public.current_app_role() = 'admin', false)
$$;

-- New sign-ups get a profile with the lowest role. Roles are raised by an admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stop non-admins from promoting themselves.
create or replace function public.guard_profile_role()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Only an admin can change roles';
  end if;
  return new;
end $$;

create trigger profiles_guard_role before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ---------- Lead sources (reference data) ---------------------------
create table public.lead_sources (
  id         smallint generated always as identity primary key,
  code       text not null unique check (code ~ '^[a-z_]+$'),
  label_en   text not null,
  label_es   text not null,
  is_paid    boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.lead_sources (code, label_en, label_es, is_paid) values
  ('website',         'Website form',             'Formulario web',             false),
  ('phone',           'Phone call',               'Llamada',                    false),
  ('google_business', 'Google Business Profile',  'Perfil de Google',           false),
  ('google_lsa',      'Google Local Services Ads','Anuncios locales de Google', true),
  ('facebook',        'Facebook',                 'Facebook',                   false),
  ('instagram',       'Instagram',                'Instagram',                  false),
  ('nextdoor',        'Nextdoor',                 'Nextdoor',                   false),
  ('referral',        'Customer referral',        'Recomendación de cliente',   false),
  ('repeat',          'Repeat customer',          'Cliente que regresa',        false),
  ('partner',         'Partner referral',         'Recomendación de socio',     false),
  ('outreach',        'Commercial outreach',      'Prospección comercial',      false),
  ('yard_sign',       'Yard sign / truck',        'Letrero / camioneta',        false),
  ('other',           'Other',                    'Otro',                       false);

-- ---------- Contacts -------------------------------------------------
create table public.contacts (
  id                 uuid primary key default gen_random_uuid(),
  full_name          text not null check (length(btrim(full_name)) between 1 and 200),
  phone_e164         text check (phone_e164 ~ '^\+1[2-9][0-9]{9}$'),
  email              text check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  preferred_language public.app_language not null default 'en',
  company_name       text check (length(company_name) <= 200),
  notes              text check (length(notes) <= 5000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint contacts_reachable check (phone_e164 is not null or email is not null)
);
-- Duplicate prevention: one contact per phone and per email (case-insensitive).
create unique index contacts_phone_unique on public.contacts (phone_e164) where phone_e164 is not null;
create unique index contacts_email_unique on public.contacts (lower(email)) where email is not null;
create index contacts_name_search on public.contacts (lower(full_name));
create trigger contacts_updated_at before update on public.contacts
  for each row execute function public.set_updated_at();

-- ---------- Properties (service addresses) --------------------------
create table public.properties (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.contacts (id) on delete restrict,
  address_line1 text not null check (length(btrim(address_line1)) between 3 and 200),
  address_line2 text check (length(address_line2) <= 200),
  city          text not null check (length(btrim(city)) between 2 and 100),
  state         text not null default 'IL' check (state ~ '^[A-Z]{2}$'),
  zip           text not null check (zip ~ '^[0-9]{5}$'),
  notes         text check (length(notes) <= 2000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index properties_contact_address_unique
  on public.properties (contact_id, lower(btrim(address_line1)), zip);
create index properties_zip on public.properties (zip);
create trigger properties_updated_at before update on public.properties
  for each row execute function public.set_updated_at();

-- ---------- Consents (TCPA / CAN-SPAM record keeping) ---------------
create table public.contact_consents (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references public.contacts (id) on delete cascade,
  channel     public.contact_channel not null,
  purpose     public.consent_purpose not null,
  source      text not null check (length(source) between 1 and 100), -- e.g. 'website_form_v1'
  evidence    text check (length(evidence) <= 1000),                  -- exact checkbox wording shown
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint consent_revoked_after_grant check (revoked_at is null or revoked_at >= granted_at)
);
-- One active consent per contact/channel/purpose.
create unique index contact_consents_active_unique
  on public.contact_consents (contact_id, channel, purpose) where revoked_at is null;

-- ---------- Leads ----------------------------------------------------
create table public.leads (
  id                  uuid primary key default gen_random_uuid(),
  contact_id          uuid not null references public.contacts (id) on delete restrict,
  property_id         uuid references public.properties (id) on delete set null,
  source_id           smallint not null references public.lead_sources (id),
  lead_type           public.lead_type not null default 'residential',
  service_type        public.service_type not null default 'other',
  stage               public.lead_stage not null default 'new',
  description         text check (length(description) <= 5000),
  is_urgent           boolean not null default false,
  lost_reason         text check (length(lost_reason) <= 500),
  estimate_amount     numeric(10,2) check (estimate_amount is null or estimate_amount >= 0),
  assigned_to         uuid references public.profiles (id) on delete set null,
  -- Idempotency: the Worker sends a unique key per form submission so a
  -- double-tap or retry never creates two leads.
  intake_key          text unique check (length(intake_key) between 8 and 100),
  first_contacted_at  timestamptz,
  stage_changed_at    timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index leads_stage_created on public.leads (stage, created_at desc);
create index leads_contact on public.leads (contact_id);
create index leads_source on public.leads (source_id);
create trigger leads_updated_at before update on public.leads
  for each row execute function public.set_updated_at();

-- ---------- Activities (timeline) -----------------------------------
create table public.activities (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references public.contacts (id) on delete cascade,
  lead_id     uuid references public.leads (id) on delete cascade,
  type        public.activity_type not null,
  body        text check (length(body) <= 10000),
  metadata    jsonb not null default '{}'::jsonb,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index activities_contact_created on public.activities (contact_id, created_at desc);
create index activities_lead_created on public.activities (lead_id, created_at desc);

-- Log every stage change and stamp first contact time automatically.
create or replace function public.track_lead_stage()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if new.stage is distinct from old.stage then
    new.stage_changed_at := now();
    if old.stage = 'new' and new.first_contacted_at is null then
      new.first_contacted_at := now();
    end if;
    insert into public.activities (contact_id, lead_id, type, body, metadata, created_by)
    values (new.contact_id, new.id, 'stage_change',
            old.stage::text || ' -> ' || new.stage::text,
            jsonb_build_object('from', old.stage, 'to', new.stage),
            auth.uid());
  end if;
  return new;
end $$;

create trigger leads_track_stage before update on public.leads
  for each row execute function public.track_lead_stage();

-- ---------- Inbound lead intake (called only by the Worker) ---------
-- Atomically: find-or-create contact (by phone, then email), find-or-create
-- property, record consent, create lead, log the submission.
-- Returns the lead id and whether it was a duplicate submission.
create or replace function public.create_inbound_lead(
  p_intake_key      text,
  p_full_name       text,
  p_phone           text,
  p_email           text,
  p_language        public.app_language,
  p_address_line1   text,
  p_city            text,
  p_zip             text,
  p_service_type    public.service_type,
  p_lead_type       public.lead_type,
  p_description     text,
  p_is_urgent       boolean,
  p_source_code     text,
  p_sms_consent     boolean,
  p_consent_text    text
)
returns table (lead_id uuid, contact_id uuid, is_duplicate boolean)
language plpgsql security definer
set search_path = public as $$
#variable_conflict use_column
declare
  v_phone      text := public.normalize_us_phone(p_phone);
  v_email      text := nullif(lower(btrim(p_email)), '');
  v_contact_id uuid;
  v_property_id uuid;
  v_lead_id    uuid;
  v_source_id  smallint;
begin
  if p_intake_key is null or length(p_intake_key) < 8 then
    raise exception 'intake_key is required' using errcode = '22023';
  end if;

  -- Idempotent retry: same submission returns the existing lead.
  select l.id, l.contact_id into v_lead_id, v_contact_id
  from public.leads l where l.intake_key = p_intake_key;
  if found then
    return query select v_lead_id, v_contact_id, true;
    return;
  end if;

  if p_phone is not null and btrim(p_phone) <> '' and v_phone is null then
    raise exception 'invalid phone number' using errcode = '22023';
  end if;
  if v_phone is null and v_email is null then
    raise exception 'phone or email is required' using errcode = '22023';
  end if;

  select id into v_source_id from public.lead_sources
  where code = coalesce(p_source_code, 'website') and active;
  if v_source_id is null then
    raise exception 'unknown lead source %', p_source_code using errcode = '22023';
  end if;

  -- Find existing contact by phone first, then by email.
  select c.id into v_contact_id from public.contacts c where c.phone_e164 = v_phone;
  if v_contact_id is null and v_email is not null then
    select c.id into v_contact_id from public.contacts c where lower(c.email) = v_email;
  end if;

  if v_contact_id is null then
    insert into public.contacts (full_name, phone_e164, email, preferred_language)
    values (btrim(p_full_name), v_phone, v_email, coalesce(p_language, 'en'))
    returning id into v_contact_id;
  else
    -- Fill gaps only; never overwrite data the owner already has.
    update public.contacts c
       set phone_e164 = coalesce(c.phone_e164, v_phone),
           email      = coalesce(c.email, v_email)
     where c.id = v_contact_id
       and not exists (select 1 from public.contacts o
                       where o.id <> v_contact_id
                         and (o.phone_e164 = v_phone or lower(o.email) = v_email));
  end if;

  if p_address_line1 is not null and btrim(p_address_line1) <> '' then
    insert into public.properties (contact_id, address_line1, city, zip)
    values (v_contact_id, btrim(p_address_line1), btrim(p_city), btrim(p_zip))
    on conflict (contact_id, lower(btrim(address_line1)), zip) do nothing
    returning id into v_property_id;

    if v_property_id is null then
      select p.id into v_property_id from public.properties p
      where p.contact_id = v_contact_id
        and lower(btrim(p.address_line1)) = lower(btrim(p_address_line1))
        and p.zip = btrim(p_zip);
    end if;
  end if;

  -- Replying to someone who asked us to contact them is transactional.
  if v_phone is not null and p_sms_consent then
    insert into public.contact_consents (contact_id, channel, purpose, source, evidence)
    values (v_contact_id, 'sms', 'transactional', 'website_form_v1', p_consent_text)
    on conflict do nothing;
  end if;

  insert into public.leads (contact_id, property_id, source_id, lead_type, service_type,
                            description, is_urgent, intake_key)
  values (v_contact_id, v_property_id, v_source_id, coalesce(p_lead_type, 'residential'),
          coalesce(p_service_type, 'other'), p_description, coalesce(p_is_urgent, false),
          p_intake_key)
  returning id into v_lead_id;

  insert into public.activities (contact_id, lead_id, type, body, metadata)
  values (v_contact_id, v_lead_id, 'form_submission', p_description,
          jsonb_build_object('source', coalesce(p_source_code, 'website')));

  return query select v_lead_id, v_contact_id, false;
end $$;

revoke all on function public.create_inbound_lead(
  text, text, text, text, public.app_language, text, text, text,
  public.service_type, public.lead_type, text, boolean, text, boolean, text
) from public, anon, authenticated;
grant execute on function public.create_inbound_lead(
  text, text, text, text, public.app_language, text, text, text,
  public.service_type, public.lead_type, text, boolean, text, boolean, text
) to service_role;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ---------- Row Level Security --------------------------------------
-- Rule: anonymous users can do nothing. Owner and admin see all business
-- data. Crew gets access in a later migration (assigned jobs only).
alter table public.profiles         enable row level security;
alter table public.lead_sources     enable row level security;
alter table public.contacts         enable row level security;
alter table public.properties       enable row level security;
alter table public.contact_consents enable row level security;
alter table public.leads            enable row level security;
alter table public.activities       enable row level security;

revoke all on public.profiles, public.lead_sources, public.contacts, public.properties,
              public.contact_consents, public.leads, public.activities from anon;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- lead_sources: staff read, admin manage
create policy lead_sources_select on public.lead_sources for select to authenticated
  using (public.is_staff());
create policy lead_sources_admin on public.lead_sources for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- business tables: staff full access (no hard deletes of contacts/leads; see below)
create policy contacts_staff on public.contacts for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy properties_staff on public.properties for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy leads_staff on public.leads for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- consents: staff read and add; revocation is an update; history is never deleted
create policy consents_select on public.contact_consents for select to authenticated
  using (public.is_staff());
create policy consents_insert on public.contact_consents for insert to authenticated
  with check (public.is_staff());
create policy consents_update on public.contact_consents for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- activities: staff read and add; the timeline is append-only
create policy activities_select on public.activities for select to authenticated
  using (public.is_staff());
create policy activities_insert on public.activities for insert to authenticated
  with check (public.is_staff() and (created_by is null or created_by = auth.uid()));

-- Data preservation: the app cannot hard-delete these (use stage 'lost'/'not_a_fit').
revoke delete on public.contacts, public.leads, public.contact_consents, public.activities
  from authenticated;
