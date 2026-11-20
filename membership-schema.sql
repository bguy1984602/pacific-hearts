-- Non-destructive membership foundation. Billing and enforcement remain OFF.
create schema ph_billing;
revoke all on schema ph_billing from public, anon, authenticated;
grant usage on schema ph_billing to authenticated, service_role;
create table ph_billing.settings (
  singleton boolean primary key default true check(singleton),
  enforcement_enabled boolean not null default false,
  billing_ready boolean not null default false,
  check(not enforcement_enabled or billing_ready)
);
insert into ph_billing.settings default values;
alter table ph_billing.settings enable row level security;
create table public.ph_membership_plans (
  id text primary key check(id in ('monthly','three_month','annual')),
  term_months integer not null check(term_months in (1,3,12)),
  price_usd numeric(10,2) check(price_usd > 0),
  price_approved boolean not null default false,
  check(not price_approved or price_usd is not null)
);
insert into public.ph_membership_plans values ('monthly',1,9.99,true),('three_month',3,null,false),('annual',12,null,false);
alter table public.ph_membership_plans enable row level security;
revoke all on public.ph_membership_plans from public, anon, authenticated;
grant select on public.ph_membership_plans to anon, authenticated;
create policy ph_read_plans on public.ph_membership_plans for select to anon, authenticated using(true);
create table public.ph_memberships (
  member_id uuid primary key references auth.users(id),
  plan text references public.ph_membership_plans(id),
  status text not null default 'inactive' check(status in ('inactive','pending','active','past_due','cancelled','expired','revoked')),
  activated_at timestamptz,
  expires_at timestamptz,
  auto_renew boolean not null default false,
  next_renewal_at timestamptz,
  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,
  processor text check(processor is null or processor = 'ccbill'),
  processor_subscription_id text unique,
  updated_at timestamptz not null default now(),
  last_processor_event_at timestamptz,
  check(expires_at is null or (activated_at is not null and expires_at > activated_at)),
  check(status <> 'active' or (plan is not null and activated_at is not null and expires_at is not null))
);
alter table public.ph_memberships enable row level security;
revoke all on public.ph_memberships from public, anon, authenticated;
grant select on public.ph_memberships to authenticated;
revoke insert, update, delete on public.ph_memberships from anon, authenticated;
create policy ph_own_membership on public.ph_memberships for select to authenticated using(member_id=(select auth.uid()));
create table ph_billing.plan_preferences (
  member_id uuid primary key references auth.users(id),
  plan text not null references public.ph_membership_plans(id),
  updated_at timestamptz not null default now()
);
alter table ph_billing.plan_preferences enable row level security;
-- Store verified normalized event metadata only, never raw cardholder payloads.
create table ph_billing.payment_events (
  processor_event_key text primary key,
  subscription_id text not null,
  event_type text not null,
  processor_timestamp timestamptz not null,
  verified_at timestamptz not null,
  processed_at timestamptz,
  outcome text
);
alter table ph_billing.payment_events enable row level security;
revoke all on all tables in schema ph_billing from public, anon, authenticated;
grant all on all tables in schema ph_billing to service_role;
grant all on public.ph_memberships, public.ph_membership_plans to service_role;

create function ph_billing.session_allowed() returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (auth.jwt()->>'is_anonymous') is distinct from 'true'
   and ph_member_management.account_allowed(auth.uid())
   and exists(select 1 from auth.sessions s
     left join ph_member_management.session_cutoffs cut on cut.member_id=s.user_id
     where s.id=nullif(auth.jwt()->>'session_id','')::uuid and s.user_id=auth.uid()
       and (cut.changed_at is null or s.created_at>cut.changed_at));
$$;
revoke all on function ph_billing.session_allowed() from public,anon;
grant execute on function ph_billing.session_allowed() to authenticated;

create function ph_billing.subscription_allowed() returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (
   exists(select 1 from public.ph_admin_roles where user_id=auth.uid())
   or not (select enforcement_enabled from ph_billing.settings where singleton)
   or exists(select 1 from public.ph_memberships where member_id=auth.uid()
      and status in ('active','cancelled','past_due') and activated_at<=statement_timestamp() and expires_at>statement_timestamp())
 );
$$;
revoke all on function ph_billing.subscription_allowed() from public, anon;
grant execute on function ph_billing.subscription_allowed() to authenticated;

-- Preserve the existing moderation, session-revocation and anonymous checks.
-- This single shared server check is already used by RLS and messaging RPCs.
create or replace function ph_member_management.current_member_allowed() returns boolean
language sql stable security definer set search_path='' as $$
 select (auth.jwt()->>'is_anonymous') is distinct from 'true'
   and ph_member_management.account_allowed(auth.uid())
   and exists(select 1 from auth.sessions s
     left join ph_member_management.session_cutoffs cut on cut.member_id=s.user_id
     where s.id=nullif(auth.jwt()->>'session_id','')::uuid and s.user_id=auth.uid()
       and (cut.changed_at is null or s.created_at>cut.changed_at))
   and ph_billing.subscription_allowed();
$$;

create function ph_billing.membership_status() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m public.ph_memberships; pref text; staff boolean;
begin
 if not ph_billing.session_allowed() then
   raise exception 'Sign in to manage membership' using errcode='42501';
 end if;
 select * into m from public.ph_memberships where member_id=auth.uid();
 select plan into pref from ph_billing.plan_preferences where member_id=auth.uid();
 select exists(select 1 from public.ph_admin_roles where user_id=auth.uid()) into staff;
 return jsonb_build_object('plan',m.plan,'status',coalesce(m.status,'inactive'),
  'effective_status',case when m.expires_at<=statement_timestamp() and m.status in ('active','cancelled','past_due') then 'expired' else coalesce(m.status,'inactive') end,
  'activated_at',m.activated_at,'expires_at',m.expires_at,'auto_renew',coalesce(m.auto_renew,false),
  'next_renewal_at',m.next_renewal_at,'cancel_at_period_end',coalesce(m.cancel_at_period_end,false),
  'selected_plan',pref,'staff_exempt',staff,'enforcement_enabled',(select enforcement_enabled from ph_billing.settings where singleton));
end;
$$;
create function public.ph_membership_status() returns jsonb language sql stable set search_path='' as $$select ph_billing.membership_status()$$;
create function ph_billing.select_plan(chosen_plan text) returns void
language plpgsql security definer set search_path='' as $$
begin
 -- An expired member with a valid session can still choose a renewal term.
 if not ph_billing.session_allowed() then
  raise exception 'Not authorized' using errcode='42501';
 end if;
 if chosen_plan not in ('monthly','three_month','annual') or chosen_plan is null then
  raise exception 'Invalid plan' using errcode='22023';
 end if;
 insert into ph_billing.plan_preferences(member_id,plan) values(auth.uid(),chosen_plan)
 on conflict(member_id) do update set plan=excluded.plan,updated_at=now();
end;
$$;
create function public.ph_select_membership_plan(chosen_plan text) returns void language sql set search_path='' as $$select ph_billing.select_plan(chosen_plan)$$;
revoke all on function ph_billing.membership_status(), ph_billing.select_plan(text), public.ph_membership_status(),public.ph_select_membership_plan(text) from public,anon;
grant execute on function ph_billing.membership_status(), ph_billing.select_plan(text),public.ph_membership_status(),public.ph_select_membership_plan(text) to authenticated;
insert into public.ph_memberships(member_id) select id from auth.users where deleted_at is null on conflict do nothing;
-- New users need no paid row to register. Their status is inactive until a verified activation.

-- Only a trusted server adapter may call this AFTER independently verifying
-- processor account, subscription ownership, payment amount/currency and event.
-- Never call this from a browser or an unverified webhook handler.
create function public.ph_apply_verified_membership_event(
 event_key text, member uuid, subscription text, event_kind text,
 occurred_at timestamptz, approved_plan text default null,
 period_start timestamptz default null, period_end timestamptz default null
) returns text language plpgsql set search_path='' as $$
declare m public.ph_memberships; event_owner text;
begin
 if event_key is null or length(event_key)>200 or subscription is null or subscription='' or occurred_at is null
  or event_kind not in ('activation','renewal','cancellation','failure','expiration','revocation') or event_kind is null then
  raise exception 'Invalid normalized event' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(1924287103,hashtext(member::text));
 select subscription_id into event_owner from ph_billing.payment_events where processor_event_key=event_key;
 if found then
  if event_owner<>subscription then raise exception 'Conflicting event identifier'; end if;
  return 'duplicate';
 end if;
 select * into m from public.ph_memberships where member_id=member for update;
 if m.processor_subscription_id is not null and m.processor_subscription_id<>subscription then
  raise exception 'Subscription mismatch';
 end if;
 if exists(select 1 from public.ph_memberships where processor_subscription_id=subscription and member_id<>member) then
  raise exception 'Subscription already assigned';
 end if;
 insert into ph_billing.payment_events(processor_event_key,subscription_id,event_type,processor_timestamp,verified_at)
 values(event_key,subscription,event_kind,occurred_at,clock_timestamp());
 if m.last_processor_event_at is not null and occurred_at<=m.last_processor_event_at then
  update ph_billing.payment_events set processed_at=clock_timestamp(),outcome='stale' where processor_event_key=event_key;
  return 'stale';
 end if;
 if event_kind in ('activation','renewal') then
  if not exists(select 1 from public.ph_membership_plans where id=approved_plan and price_approved)
   or period_start is null or period_end is null or period_end<=period_start then
   raise exception 'Unapproved plan or invalid paid period';
  end if;
  if event_kind='renewal' and m.processor_subscription_id is null then raise exception 'Unknown renewal'; end if;
  insert into public.ph_memberships(member_id,plan,status,activated_at,expires_at,auto_renew,next_renewal_at,
    processor,processor_subscription_id,last_processor_event_at)
  values(member,approved_plan,'active',period_start,period_end,true,period_end,'ccbill',subscription,occurred_at)
  on conflict(member_id) do update set plan=excluded.plan,status='active',activated_at=excluded.activated_at,
    expires_at=excluded.expires_at,auto_renew=true,next_renewal_at=excluded.next_renewal_at,
    processor='ccbill',processor_subscription_id=subscription,last_processor_event_at=occurred_at,
    cancel_at_period_end=false,cancelled_at=null,updated_at=now();
 else
  if m.processor_subscription_id is null then raise exception 'Unknown subscription'; end if;
  update public.ph_memberships set
    status=case event_kind when 'cancellation' then 'cancelled' when 'failure' then 'past_due'
       when 'expiration' then 'expired' when 'revocation' then 'revoked' end,
    auto_renew=case when event_kind='failure' then auto_renew else false end,
    next_renewal_at=case when event_kind='failure' then next_renewal_at else null end,
    cancel_at_period_end=case when event_kind='cancellation' then true else cancel_at_period_end end,
    cancelled_at=case when event_kind='cancellation' then occurred_at else cancelled_at end,
    last_processor_event_at=occurred_at,updated_at=now()
  where member_id=member;
 end if;
 update ph_billing.payment_events set processed_at=clock_timestamp(),outcome='applied' where processor_event_key=event_key;
 return 'applied';
end;
$$;
revoke all on function public.ph_apply_verified_membership_event(text,uuid,text,text,timestamptz,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.ph_apply_verified_membership_event(text,uuid,text,text,timestamptz,text,timestamptz,timestamptz) to service_role;
