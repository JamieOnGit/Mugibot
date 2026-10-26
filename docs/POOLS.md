# 🤝 Pools: one watchlist, shared, and checkouts started together

A pool shares one admin's **watchlist, armed items and drop watches** with the
members who join it. The admin who made it is the pool's **leader**. Each
member's copy stays in step with the leader's as the leader changes it.

A member can also switch on **checking out with the leader**. From then on,
whenever the leader's Auto-checkout starts, the member's starts too, for the
same item:

- the leader's ⚡ Buy, on the dashboard or in Discord;
- the leader's **Trigger ACO**;
- one of the leader's armed items dropping.

Each member's checkout is their own, run on their own account: their checkout
browser, their saved card and delivery details, and their Auto-checkout limits,
up to the most they set for the pool.

Code: `server/pools.js` (the engine), `server/aco.js` (`trigger` → `fanOut`),
`server/routes/admin.js` and `server/routes/user.js` (the routes), and
`web/js/admin.js` and `web/js/app.js` (the console and the dashboard). Tests:
`test/pools.test.js` (server), `test/pools.ui.test.js` (both pages in a real
browser) and the pool test in `test/extension.e2e.test.js` (a member's real
browser checking out on the dummy Kmart).

## What each person decides

| Who | Decides | Where |
|---|---|---|
| An admin | Makes a pool (they lead it), names it, asks members to join, takes them out, closes it | Admin console → **Members → 🤝 Pools** |
| The member | Joins or says no thanks (one pool at a time) | Dashboard → Checkout → **🤝 Pool** (the DM's button opens it: `/app#pool`) |
| The member | Switches on **checking out with the leader**: they tick the agreement the first time and set the most it may cost them an item. Their own Auto-checkout must be on. | 🤝 Pool card |
| The member | Skips one of the leader's items (**🤝 Skip**): it is never armed on theirs and never started by the leader's checkouts | Their watchlist, or 🎯 Armed |
| The member | Leaves | 🤝 Pool card → **Leave the pool** |

An admin can't switch on checking out with the leader for anyone, and can't
see what a member would spend. The console shows only who joined and whether
each one checks out with the leader. Joining again after leaving starts with
checking out switched off.

A leader isn't a member of anyone else's pool. A member is in one pool at a
time, and a pool has up to 50 members.

## What's shared, and how it stays in step

**The watchlist.** Every item on the leader's watchlist is on each member's,
marked **🤝 leader's**. It has the leader's name, SKU, link, quantity, discount
code and stock. A pause or a removal follows too. The copy follows straight
away whenever the leader adds, edits, pauses or removes an item.
Their open dashboards update by themselves.

A copy is the leader's to change, so members get no Edit, Pause or ✕ on it,
only **🤝 Skip**. They keep their own ⚡ Buy and ↻, and put the copies in their own order. If a member already
watches the same store and SKU themselves, theirs stays as it is and no copy is
made.

**Armed.** A copy is armed only when:

- the leader's item is armed;
- the leader's Auto-checkout is on;
- the member checks out with the leader;
- the member hasn't skipped it.

Its max price is the leader's, but never over the most the member set for the
pool. A copy that has bought for this arming of the leader's isn't armed again
until the leader arms theirs again, so one arming means one purchase each.

**Drop watches.** The leader's own drop watches show on each member's Drop
watches, in a list of their own: **🤝 From your pool — leader's**. Members
can't change or remove them. What a watch finds goes on the leader's watchlist,
so it's on each member's as a copy, armed as above. The leader's drop watches
that are "for everyone" show to every member anyway, as before.

## When the leader checks out

| The leader… | Members who check out with them |
|---|---|
| presses **Trigger ACO** (or 🚦 Wait for queue, then ACO) | each one's copy starts now, armed or not (unless they skipped it) |
| presses **⚡ Buy** in Discord, or ⚡ Buy on the dashboard with "Place the order for me" | the same |
| has an armed item drop | each one's **armed** copy starts |

The member's run is an ordinary Auto-checkout run of their own, labelled
**🤝 with your pool** in their run history. Its DM says that the leader started
it. It is checked like every run:

- their Auto-checkout is on;
- the store's checkout is ready in their checkout browser;
- the total is within their max for the item and their limits (an order, orders
  a day, spending a day);
- "Place the order for me", or stop at the final button, as they chose.

Only one checkout of an item runs at a time. When a member's own monitor sees
the same drop, it joins the run the leader's started instead of making a second.
A member whose Auto-checkout is off is told the leader started one, and nothing
starts on their account.

Every guardrail stays as it is. Each run stops for a bank's approval, a bot
check, a declined card, another item in the bag, or a total over the member's
limits. Mugibot never gets past a CAPTCHA, a queue or a store's purchase limit
for anyone, and it never makes or runs other accounts.

## For admins

- **Make a pool:** Members → 🤝 Pools → name it → **+ Make a pool**.
- **Ask someone:** type their username → **Ask to join**. They get a notice on
  their dashboard, plus a Discord DM and an email if they've connected them,
  each with an **Open** button.
- **Take someone out**, **Cancel ask**, **Rename** or **Close pool**: the
  member's copies of your items come off their watchlist. A copy that is
  checking out right now finishes first.
- Every change is in the audit log (`pool-create`, `pool-rename`,
  `pool-invite`, `pool-remove`, `pool-close`).

Your own **🤝 Pool** card (Checkout page) lists the pools you lead: who's in, and
who checks out with you.
