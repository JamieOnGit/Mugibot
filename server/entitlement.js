// Can this account use ⚡ Buy, checkout autofill, restock checks and the
// members' Discord right now?

const DAY = 24 * 60 * 60 * 1000;

const date = (ts) => new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

export function entitlement(user, now = Date.now()) {
  const trialEndsAt = user.trial_ends_at || null;
  const base = { plan: user.plan, trialEndsAt, currentPeriodEnd: user.current_period_end || null, cancelAtPeriodEnd: !!user.cancel_at_period_end };
  if (user.role === 'admin') return { ...base, active: true, label: 'Admin' };
  switch (user.plan) {
    case 'active':
      return { ...base, active: true, label: user.cancel_at_period_end && user.current_period_end ? `Member (ends ${date(user.current_period_end)})` : 'Member' };
    case 'comped': return { ...base, active: true, label: 'Free access' };
    case 'past_due': return { ...base, active: true, label: 'Payment failed — update your card on Whop', warning: true };
    case 'trial': {
      const left = trialEndsAt ? trialEndsAt - now : 0;
      const days = Math.max(1, Math.ceil(left / DAY));
      return left > 0
        ? { ...base, active: true, label: `Free trial — ${days} day${days === 1 ? '' : 's'} left` }
        : { ...base, active: false, label: 'Free trial ended' };
    }
    case 'canceled': return { ...base, active: false, label: 'Membership ended' };
    default: return { ...base, active: false, label: 'Not a member yet' };
  }
}
