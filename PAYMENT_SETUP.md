# Pacific Hearts membership rollout

Billing and paid-access enforcement are OFF. Do not enable either without Brad's approval and passing sandbox tests. No checkout URL or processor credentials are configured.

## Implemented

Monthly $9.99 USD, three months $26.99 USD, annual $89.99 USD (all prices approved), PHP reference estimates, account membership page and server-saved plan preferences. Selecting a plan never activates access or billing. Membership RLS permits only the member to read their record; clients cannot write paid status. Existing staff are exempt. Existing session and moderation checks remain in place.

`membership-schema.sql` is the source of the applied non-destructive database migration. Paid term fields include activation, expiration, recurrence, cancellation and processor reference. Status is evaluated against server time. Cancellation retains access to the paid-through date; failed renewals never extend that date. Expired/revoked subscriptions deny access once enforcement is enabled. An empty inactive membership row is seeded for existing users; new accounts report inactive without needing a paid row.

The service-role-only `ph_apply_verified_membership_event` RPC accepts normalized, independently verified events. It deduplicates event keys, rejects older or conflicting events, serializes per member, enforces approved plans and subscription uniqueness, and handles activation, renewal, cancellation, failure, expiration and revocation. It does NOT verify CCBill webhooks itself. Never expose service-role credentials to clients.

## Processor research and remaining setup

CCBill is preferred: its dating program explicitly supports dating/relationship sites and recurring subscriptions: https://ccbill.com/docs/Product-Information/date.pdf . Merchant underwriting must confirm US/Philippines coverage, accepted payment methods, exact recurring intervals and eligibility for this business. Confirm calendar-month versus day-based billing before displaying final checkout terms. Epoch and Segpay can be evaluated as alternatives if CCBill declines; neither is integrated or approved for this site.

1. Enroll the existing business/site with CCBill. Obtain approval, merchant account/subaccount, hosted form identifiers, API/DataLink access and sandbox/testing instructions. No enrollment or purchase has been made.
2. Approved catalog: `monthly` = $9.99 / 1 month, `three_month` = $26.99 / 3 months, `annual` = $89.99 / 12 months. Map these IDs to the merchant-approved recurring checkout options; price approval alone does not enable billing.
3. Configure recurring terms and USD prices on CCBill hosted checkout. Show price, interval, recurring consent, cancellation details and next billing date before purchase. Store credentials only as Supabase server secrets. Never collect or store card numbers in Supabase.
4. Implement an authenticated checkout Edge Function using `auth.getUser`. Create a server-side pending checkout record tied to the signed-in member and approved processor plan; pass an opaque correlation ID. Do not accept browser-supplied amounts, membership IDs or a return-page success flag as payment proof.
5. Complete `ccbill-webhook.ts`. It currently rejects every POST with HTTP 503 and cannot activate memberships. The official guide documents source IP ranges, not a generic HMAC header: https://ccbill.com/doc/webhooks-user-guide . Enforce verified sender identity using trusted ingress metadata and reconcile subscription/account/amount/currency/ownership through CCBill's authenticated server interface. Never trust arbitrary forwarded headers. Confirm the actual merchant API and event payloads before implementing that adapter. Call the normalized event RPC only after successful verification. Persist no raw cardholder payloads. Return non-2xx on incomplete verification so events are not silently acknowledged.
6. Map NewSaleSuccess/RenewalSuccess, Cancellation, RenewalFailure, Expiration and refund/chargeback events to verified normalized events. Use processor-confirmed paid-through timestamps, unique event keys and event timestamps. Add reconciliation for missed notifications and equal-timestamp event ordering before launch.
7. Connect renewal checkout and a processor cancellation/management flow. Do not report cancellation success until CCBill confirms it. The current UI explicitly says those actions are unavailable.
8. Test signed-in checkout, member correlation, duplicate/replayed/out-of-order events, spoofed requests, renewal, failed payment, cancellation with remaining access, expiration, refunds and staff exemption. Test all three approved terms. Validate existing registration, sign-in, photos, search, messaging, blocking and admin workflows with authorized test accounts.
9. Only with approval: mark billing ready and then enable enforcement in private `ph_billing.settings`. Keep an administrative rollback path. The database constraint prevents enabling enforcement while billing_ready is false. Do not enable restrictions during setup.

PHP values use https://api.frankfurter.dev/v2/rates?base=USD&quotes=PHP and display the rate date. Failed requests show unavailable instead of an invented rate. Actual billing remains USD.

## US and Philippines payment review (2026-11-19)

CCBill documents worldwide credit/debit card and CCBill Pay acceptance, including recurring payments in USD. PHP is not among its listed billing currencies. This supports preparing USD card checkout for US and Philippine customers; merchant underwriting and issuer acceptance still need confirmation for this specific dating business. Do not advertise GCash or Maya support without explicit processor confirmation.

Merchant eligibility differs from customer geography: CCBill requires a business/legal presence and proof in a supported merchant region (including the United States); the Philippines is not on the documented merchant-country list. Obtain underwriting approval, identity/business/bank documentation requirements, settlement terms, processing fees, any reserves and any card registration fees directly from CCBill before agreeing to services. No account or service was purchased.

Before launch, confirm the exact recurring intervals (calendar months versus day counts), cancellation/refund disclosures, customer support details, billing descriptor, Terms and Privacy pages, and required recurring consent. Configure hosted FlexForms and server-side plan mappings only after approval. Complete authenticated checkout, verified webhook reconciliation, cancellation and refund handling, and CCBill test transactions before requesting approval for live billing.

Official references:
- https://ccbill.com/doc/accepted-payment-methods
- https://ccbill.com/doc/visa-and-mastercard-payment-processing-faqs
- https://ccbill.com/doc/pricing-admin
- https://ccbill.com/doc/webhooks-user-guide
- https://ccbill.com/doc/ (test-transaction setup documentation)
