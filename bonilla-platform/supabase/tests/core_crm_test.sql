-- Tests for migration 001. Each block raises an exception on failure.
-- Run: psql -v ON_ERROR_STOP=1 -f core_crm_test.sql
\set QUIET on

-- Users: one admin, one owner, one crew
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@test',  '{"full_name":"Admin"}'),
  ('00000000-0000-0000-0000-0000000000b2', 'owner@test',  '{"full_name":"Owner"}'),
  ('00000000-0000-0000-0000-0000000000c3', 'crew@test',   '{"full_name":"Crew"}');
update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a1';
update public.profiles set role = 'owner' where id = '00000000-0000-0000-0000-0000000000b2';

do $$ begin
  assert (select count(*) from public.profiles) = 3, 'signup trigger should create 3 profiles';
  assert (select role from public.profiles where id = '00000000-0000-0000-0000-0000000000c3') = 'crew',
         'new users default to crew';
  assert public.normalize_us_phone('(847) 409-1584') = '+18474091584', 'phone normalize 10 digits';
  assert public.normalize_us_phone('1-847-409-1584') = '+18474091584', 'phone normalize 11 digits';
  assert public.normalize_us_phone('12345') is null, 'short phone rejected';
  raise notice 'PASS profiles and phone normalization';
end $$;

-- ---------- Intake as the Worker (service_role) ----------
set role service_role;

do $$
declare r record; r2 record; r3 record;
begin
  select * into r from public.create_inbound_lead(
    'key-aaaa-0001', 'Maria Lopez', '(847) 555-0101', 'Maria@Example.com', 'es',
    '123 Main St', 'Waukegan', '60085', 'tree_removal', 'residential',
    'Dead ash leaning toward garage', true, 'website', true, 'You may text me about this request.');
  assert r.is_duplicate = false, 'first submission is not a duplicate';

  -- Double-tap / retry with same key -> same lead, flagged duplicate
  select * into r2 from public.create_inbound_lead(
    'key-aaaa-0001', 'Maria Lopez', '(847) 555-0101', 'maria@example.com', 'es',
    '123 Main St', 'Waukegan', '60085', 'tree_removal', 'residential',
    'Dead ash leaning toward garage', true, 'website', true, 'x');
  assert r2.is_duplicate and r2.lead_id = r.lead_id, 'retry returns same lead';

  -- New request from same person (different key, phone formatted differently)
  select * into r3 from public.create_inbound_lead(
    'key-aaaa-0002', 'Maria L.', '8475550101', null, 'es',
    '123 MAIN ST ', 'Waukegan', '60085', 'tree_trimming', 'residential',
    'Also trim the maple', false, 'facebook', false, null);
  assert r3.contact_id = r.contact_id, 'same phone reuses contact';
  assert r3.lead_id <> r.lead_id, 'new request creates a new lead';

  assert (select count(*) from public.contacts) = 1, 'no duplicate contacts';
  assert (select count(*) from public.properties) = 1, 'same address reused (case/space-insensitive)';
  assert (select count(*) from public.leads) = 2, 'two leads';
  assert (select count(*) from public.contact_consents) = 1, 'one active sms consent';
  assert (select count(*) from public.activities where type = 'form_submission') = 2, 'submissions logged';
  assert (select email from public.contacts) = 'maria@example.com', 'email stored lowercase';
  raise notice 'PASS intake, idempotency and dedupe';
end $$;

do $$ begin
  begin
    perform public.create_inbound_lead('key-bad-0003', 'X', '123', null, 'en',
      null, null, null, 'other', 'residential', null, false, 'website', false, null);
    raise exception 'should have failed';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.create_inbound_lead('key-bad-0004', 'X', null, null, 'en',
      null, null, null, 'other', 'residential', null, false, 'website', false, null);
    raise exception 'should have failed';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.create_inbound_lead('key-bad-0005', 'X', '8475550199', null, 'en',
      null, null, null, 'other', 'residential', null, false, 'tiktok_spam', false, null);
    raise exception 'should have failed';
  exception when sqlstate '22023' then null; end;

  begin
    perform public.create_inbound_lead('key-bad-0006', 'X', '8475550199', null, 'en',
      '1 Oak Rd', 'Gurnee', 'ABCDE', 'other', 'residential', null, false, 'website', false, null);
    raise exception 'should have failed';
  exception when check_violation then null; end;

  assert (select count(*) from public.leads) = 2, 'failed submissions left nothing behind';
  raise notice 'PASS input validation';
end $$;

-- Email-only lead from a commercial contact
do $$ declare r record; begin
  select * into r from public.create_inbound_lead('key-com-0007', 'Lakeview HOA', null,
    'board@lakeviewhoa.org', 'en', '500 Lake Dr', 'Gurnee', '60031', 'tree_trimming',
    'commercial', 'Annual pruning quote, 40 trees', false, 'website', false, null);
  assert (select lead_type from public.leads where id = r.lead_id) = 'commercial', 'commercial lead';
  raise notice 'PASS email-only commercial lead';
end $$;

reset role;

-- ---------- Anonymous users: nothing ----------
set role anon;
do $$ begin
  begin perform 1 from public.contacts; raise exception 'anon read contacts';
  exception when insufficient_privilege then null; end;
  begin perform public.create_inbound_lead('key-anon-0008','A','8475550100',null,'en',
          null,null,null,'other','residential',null,false,'website',false,null);
        raise exception 'anon called intake';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS anon blocked';
end $$;
reset role;

-- ---------- Crew: no business data yet ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c3';
do $$ begin
  assert (select count(*) from public.contacts) = 0, 'crew sees no contacts';
  assert (select count(*) from public.leads) = 0, 'crew sees no leads';
  assert (select count(*) from public.profiles) = 1, 'crew sees only own profile';
  begin
    update public.profiles set role = 'admin' where id = auth.uid();
    raise exception 'crew self-promoted';
  exception when raise_exception then
    if sqlerrm = 'crew self-promoted' then raise; end if;
  end;
  begin perform public.create_inbound_lead('key-crew-0009','A','8475550100',null,'en',
          null,null,null,'other','residential',null,false,'website',false,null);
        raise exception 'crew called intake';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS crew restricted';
end $$;

-- ---------- Owner: full working access ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$ declare v_lead uuid; begin
  assert (select count(*) from public.leads) = 3, 'owner sees all leads';
  select id into v_lead from public.leads where intake_key = 'key-aaaa-0001';
  update public.leads set stage = 'contacted' where id = v_lead;
  assert (select first_contacted_at is not null from public.leads where id = v_lead), 'first contact stamped';
  assert (select count(*) from public.activities where lead_id = v_lead and type = 'stage_change') = 1,
         'stage change logged';
  insert into public.activities (contact_id, lead_id, type, body, created_by)
  select contact_id, id, 'note', 'Called, visiting Saturday', auth.uid() from public.leads where id = v_lead;
  begin
    delete from public.leads where id = v_lead;
    raise exception 'owner hard-deleted a lead';
  exception when insufficient_privilege then null; end;
  begin
    update public.profiles set role = 'admin' where id = auth.uid();
    raise exception 'owner self-promoted';
  exception when raise_exception then
    if sqlerrm = 'owner self-promoted' then raise; end if;
  end;
  raise notice 'PASS owner access, stage tracking, delete protection';
end $$;

-- ---------- Admin: can manage roles ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  update public.profiles set full_name = 'Crew Member' where id = '00000000-0000-0000-0000-0000000000c3';
  assert (select full_name from public.profiles where id = '00000000-0000-0000-0000-0000000000c3') = 'Crew Member',
         'admin edits other profiles';
  raise notice 'PASS admin';
end $$;
reset role;

\echo ALL TESTS PASSED
