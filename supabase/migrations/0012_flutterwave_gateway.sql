-- Add Flutterwave as an additional hosted checkout provider.
-- Existing Safaricom M-Pesa payments remain the default provider and keep
-- their existing callback / activation flow.

alter table public.billing_payments
  add column if not exists payment_provider text not null default 'mpesa',
  add column if not exists tx_ref text,
  add column if not exists flutterwave_transaction_id text;

alter table public.billing_payments
  alter column phone_number drop not null;

alter table public.billing_payments
  drop constraint if exists billing_payments_payment_provider_check;

alter table public.billing_payments
  add constraint billing_payments_payment_provider_check
    check (payment_provider in ('mpesa', 'flutterwave'));

create unique index if not exists billing_payments_tx_ref_unique
  on public.billing_payments(tx_ref)
  where tx_ref is not null;

create unique index if not exists billing_payments_flutterwave_transaction_unique
  on public.billing_payments(flutterwave_transaction_id)
  where flutterwave_transaction_id is not null;

create index if not exists billing_payments_provider_status_created_idx
  on public.billing_payments(payment_provider, status, created_at desc);

comment on column public.billing_payments.payment_provider is
  'Payment gateway used for the subscription payment: existing Safaricom M-Pesa or Flutterwave hosted checkout.';
comment on column public.billing_payments.tx_ref is
  'Unique Podcasti reference sent to Flutterwave Standard checkout.';
comment on column public.billing_payments.flutterwave_transaction_id is
  'Flutterwave transaction ID verified server-to-server before activating a subscription.';

create or replace function public.complete_flutterwave_subscription(
  p_tx_ref text,
  p_transaction_id text,
  p_amount integer,
  p_currency text,
  p_callback_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.billing_payments%rowtype;
  v_workspace public.workspaces%rowtype;
  v_period interval;
begin
  if coalesce(btrim(p_tx_ref), '') = ''
     or coalesce(btrim(p_transaction_id), '') = '' then
    raise exception 'The Flutterwave payment reference is incomplete.';
  end if;

  select * into v_payment
  from public.billing_payments
  where tx_ref = p_tx_ref
    and payment_provider = 'flutterwave'
  for update;

  if not found then
    raise exception 'No Podcasti Flutterwave payment matches this reference.';
  end if;

  if v_payment.status = 'paid' then
    if v_payment.flutterwave_transaction_id = p_transaction_id then
      return true;
    end if;
    raise exception 'This payment reference was already completed by a different transaction.';
  end if;

  if v_payment.status <> 'pending' then
    raise exception 'This Flutterwave payment is no longer pending.';
  end if;

  if upper(coalesce(p_currency, '')) <> 'KES'
     or p_amount <> v_payment.amount_ksh then
    raise exception 'The Flutterwave amount or currency does not match the Podcasti payment.';
  end if;

  if (v_payment.plan_interval = 'monthly' and p_amount <> 3000)
     or (v_payment.plan_interval = 'yearly' and p_amount <> 15000) then
    raise exception 'The Flutterwave amount does not match the selected Podcasti plan.';
  end if;

  select * into v_workspace
  from public.workspaces
  where owner_id = v_payment.owner_id
  for update;

  if not found or v_workspace.plan = 'admin' then
    raise exception 'This account cannot be upgraded through customer billing.';
  end if;

  v_period := case
    when v_payment.plan_interval = 'yearly' then interval '1 year'
    else interval '1 month'
  end;

  update public.billing_payments
  set status = 'paid',
      flutterwave_transaction_id = p_transaction_id,
      result_code = 0,
      result_description = 'Payment verified by Flutterwave.',
      callback_payload = coalesce(p_callback_payload, '{}'::jsonb),
      paid_at = now(),
      updated_at = now()
  where id = v_payment.id;

  update public.workspaces
  set plan = 'pro',
      subscription_interval = v_payment.plan_interval,
      subscription_status = 'active',
      subscription_started_at = case
        when subscription_status = 'active' and subscription_expires_at > now()
          then coalesce(subscription_started_at, now())
        else now()
      end,
      subscription_expires_at = case
        when subscription_status = 'active' and subscription_expires_at > now()
          then subscription_expires_at + v_period
        else now() + v_period
      end,
      daily_episode_limit = 3,
      monthly_episode_limit = 90,
      updated_at = now()
  where owner_id = v_payment.owner_id;

  return true;
end;
$$;

revoke all on function public.complete_flutterwave_subscription(text, text, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_flutterwave_subscription(text, text, integer, text, jsonb)
  to service_role;
