"use strict";
const membershipClient = window.supabase?.createClient('https://oydhphpbcsiedfkkwujq.supabase.co','sb_publishable_HjB_yE3s66LO8FsS4n2iGw_Jh73wk-m');
const getMembershipElement = id => document.getElementById(id);
let membershipRevision = 0;
const planNames = {monthly:'Monthly — $9.99 USD',three_month:'Three months — $26.99 USD',annual:'Annual — $89.99 USD'};
async function loadMembership() {
  const revision = ++membershipRevision;
  getMembershipElement('plan-form').hidden = true;
  getMembershipElement('membership-signin').hidden = true;
  getMembershipElement('plan-status').textContent = '';
  try {
    if (!membershipClient) throw new Error('Membership could not load. Reload the page.');
    const {data, error} = await membershipClient.auth.getUser();
    if (revision !== membershipRevision) return;
    if (error || !data.user || data.user.is_anonymous) {
      getMembershipElement('account-status').textContent = 'Sign in to view your membership and save a plan preference.';
      getMembershipElement('membership-signin').hidden = false;
      return;
    }
    const result = await membershipClient.rpc('ph_membership_status');
    if (revision !== membershipRevision) return;
    if (result.error) throw new Error('Membership details could not load. Please try reloading.');
    const record = result.data;
    const expiry = record.expires_at ? new Date(record.expires_at).toLocaleString() : 'No paid term activated';
    getMembershipElement('account-status').textContent = (record.staff_exempt ? 'Administrator access — no purchase required\n' : '') + 'Membership: ' + record.effective_status.replaceAll('_',' ') + '\nPlan: ' + (planNames[record.plan] || 'Not selected') + '\nExpiration: ' + expiry + '\nRenewal: ' + (record.cancel_at_period_end ? 'Cancelled; access continues until expiration' : record.auto_renew ? 'Recurring' : 'Not enabled') + '\n' + (record.enforcement_enabled ? 'Paid membership access is enabled.' : 'Current access continues while billing is being prepared.');
    if (record.selected_plan) getMembershipElement('plan').value = record.selected_plan;
    getMembershipElement('plan-form').hidden = false;
  } catch(error) {
    if (revision === membershipRevision) getMembershipElement('account-status').textContent = error.message;
  }
}
getMembershipElement('plan-form').onsubmit = async event => {
  event.preventDefault();
  const revision = membershipRevision;
  const button = getMembershipElement('save-plan');
  button.disabled = true;
  try {
    const {error} = await membershipClient.rpc('ph_select_membership_plan',{chosen_plan:getMembershipElement('plan').value});
    if (error) throw error;
    if (revision === membershipRevision) getMembershipElement('plan-status').textContent = 'Plan preference saved. No charge or membership activation occurred.';
  } catch {
    if (revision === membershipRevision) getMembershipElement('plan-status').textContent = 'Your preference could not be saved. Please try again.';
  } finally {button.disabled = false;}
};
membershipClient?.auth.onAuthStateChange(() => { setTimeout(loadMembership, 0); });
window.addEventListener('pageshow', () => { void loadMembership(); });
document.addEventListener('visibilitychange', () => {if (!document.hidden) void loadMembership();});
