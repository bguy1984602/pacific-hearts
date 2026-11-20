-- All writes, including simulated payment events and enforcement, roll back.
begin;
do $$
declare member uuid; staff uuid; sid uuid; result text; initial_profiles bigint;
begin
 select id into member from auth.users where id not in(select user_id from public.ph_admin_roles) and deleted_at is null limit 1;
 select user_id into staff from public.ph_admin_roles limit 1;
 if member is null or staff is null then raise exception 'Test fixtures unavailable'; end if;
 select count(*) into initial_profiles from public.profiles;
 sid:=gen_random_uuid();
 insert into auth.sessions(id,user_id,created_at,updated_at) values(sid,member,clock_timestamp(),clock_timestamp());
 perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'session_id',sid,'role','authenticated','is_anonymous',false)::text,true);
 if not ph_billing.subscription_allowed() then raise exception 'Setup mode blocked existing member'; end if;
 begin
  update ph_billing.settings set enforcement_enabled=true;
  raise exception 'Readiness constraint failed';
 exception when check_violation then null; end;
 update ph_billing.settings set billing_ready=true,enforcement_enabled=true;
 if ph_billing.subscription_allowed() then raise exception 'Inactive member received paid access'; end if;
 result:=public.ph_apply_verified_membership_event('test-activation',member,'test-subscription','activation',now()-interval '4 minutes','monthly',now()-interval '1 day',now()+interval '29 days');
 if result<>'applied' or not ph_billing.subscription_allowed() then raise exception 'Activation failed'; end if;
 result:=public.ph_apply_verified_membership_event('test-activation',member,'test-subscription','activation',now()-interval '4 minutes','monthly',now()-interval '1 day',now()+interval '29 days');
 if result<>'duplicate' then raise exception 'Duplicate event not rejected'; end if;
 result:=public.ph_apply_verified_membership_event('test-failure',member,'test-subscription','failure',now()-interval '3 minutes');
 if result<>'applied' or not ph_billing.subscription_allowed() then raise exception 'Failure lost paid-through access'; end if;
 result:=public.ph_apply_verified_membership_event('test-cancellation',member,'test-subscription','cancellation',now()-interval '2 minutes');
 if result<>'applied' or not ph_billing.subscription_allowed() or not (public.ph_membership_status()->>'cancel_at_period_end')::boolean then raise exception 'Cancellation behavior incorrect'; end if;
 result:=public.ph_apply_verified_membership_event('test-stale',member,'test-subscription','activation',now()-interval '5 minutes','monthly',now(),now()+interval '30 days');
 if result<>'stale' then raise exception 'Old event overwrote newer status'; end if;
 update public.ph_memberships set activated_at=now()-interval '31 days',expires_at=now()-interval '1 second' where member_id=member;
 if ph_billing.subscription_allowed() or public.ph_membership_status()->>'effective_status'<>'expired' then raise exception 'Expiration not enforced'; end if;
 result:=public.ph_apply_verified_membership_event('test-renewal',member,'test-subscription','renewal',now()-interval '1 minute','monthly',now()-interval '1 second',now()+interval '30 days');
 if result<>'applied' or not ph_billing.subscription_allowed() then raise exception 'Renewal failed'; end if;
 result:=public.ph_apply_verified_membership_event('test-revoke',member,'test-subscription','revocation',now());
 if ph_billing.subscription_allowed() then raise exception 'Revoked member received access'; end if;
 begin
  perform public.ph_apply_verified_membership_event('test-unapproved',member,'test-subscription','activation',now()+interval '1 minute','annual',now(),now()+interval '1 year');
  raise exception 'Unapproved price activated';
 exception when raise_exception then
  if sqlerrm<>'Unapproved plan or invalid paid period' then raise; end if;
 end;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',staff,'role','authenticated')::text,true);
 if not ph_billing.subscription_allowed() then raise exception 'Staff exemption failed'; end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',member,'session_id',sid,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 if (select count(*) from public.ph_memberships)<>1 then raise exception 'Membership RLS leaked another record'; end if;
 begin
  update public.ph_memberships set status='active';
  raise exception 'Client membership edit permitted';
 exception when insufficient_privilege then null; end;
 begin
  update public.ph_membership_plans set price_usd=0.01;
  raise exception 'Client price edit permitted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.ph_apply_verified_membership_event('forged',member,'test-subscription','activation',now(),'monthly',now(),now()+interval '30 days');
  raise exception 'Client event forging permitted';
 exception when insufficient_privilege then null; end;
 perform public.ph_select_membership_plan('annual');
 if public.ph_membership_status()->>'selected_plan'<>'annual' then raise exception 'Preference save failed'; end if;
 if public.ph_membership_status()->>'status'<>'revoked' then raise exception 'Preference granted membership'; end if;
 execute 'reset role';
 if (select count(*) from public.profiles)<>initial_profiles then raise exception 'Profile count changed'; end if;
end;
$$;
rollback;
select 'Passed: setup access, readiness guard, activation, duplicate/stale events, failed payment, cancellation, expiration, renewal, revocation, unapproved pricing, staff exemption, membership RLS, protected writes, protected event RPC, preference persistence without activation. All test writes rolled back.' as result;
