# Whop setup: the A$19.99/month membership

Members pay on Whop. Mugibot keeps each account's membership in step with Whop:

- **Become a member** (dashboard → Membership) asks Whop for a checkout link
  that carries the member's Mugibot account ID. After paying they're sent back
  to Mugibot, and the account switches on by itself.
- **Bought on Whop first?** The member pastes their membership ID (`mem_…`) or
  license key on their Membership tab, or an admin links it for them.
- **Webhooks** keep it current: activated, renewed, payment failed (access
  continues while Whop retries), cancelled or expired (monitoring, ⚡ Buy and the
  Discord role stop; the watchlist and details are kept).

Whop's dashboard menus get renamed from time to time. If a name below doesn't
match exactly, look for the thing described.

---

## 1. Create the product and the A$19.99 plan

1. Sign in at https://whop.com and create your business (store) if you haven't. Finish payout setup.
2. **Dashboard → Products → Create product.** Name it "Mugibot Membership"
   and add a short description (what members get: SKU monitor, Discord pings,
   one-button checkout, members' server).
3. Add a **pricing option / plan**:
   - Type: **Recurring** (renewing)
   - Price: **19.99**, currency **AUD** (if AUD isn't offered on your account,
     choose USD and set `PRICE_DISPLAY` to match, e.g. `US$12.99 / month`)
   - Billing period: **every 1 month**
   - Free trial: none (or add one here; Whop handles it)
4. Copy the IDs:
   - **Product ID** (`prod_…`): Dashboard → Products, open the product. It's in
     the product's details or address bar. This is `WHOP_PRODUCT_ID`.
   - **Plan ID** (`plan_…`): open the pricing option's menu → copy ID (or from
     its checkout link). This is `WHOP_PLAN_ID`.

`WHOP_PRODUCT_ID` accepts **any** plan of that product (e.g. a yearly plan you
add later). Mugibot ignores memberships of your other Whop products.

---

## 2. Create an API key

1. **Dashboard → Developer** (the developer/API section) → **API keys** →
   **Create**. Name it "Mugibot production".
2. Permissions: the simplest is the **Admin** role. If you prefer a custom set,
   Mugibot uses:
   - `checkout_configuration:create`, `checkout_configuration:basic:read`,
     `plan:create`, `access_pass:create`, `access_pass:update`
     (making each member's checkout link)
   - `member:basic:read`, `member:email:read` (reading memberships)
   - `membership:cancel` (cancelling when someone deletes their account)
3. Copy the key now. Whop shows it once. This is `WHOP_API_KEY`.

---

## 3. Create the webhook

1. **Dashboard → Developer → Webhooks → Create webhook**.
2. URL: `https://<your address>/api/whop/webhook`. Admin → Setup check shows
   the exact URL to paste.
3. API version: **v1** (the current one, with Standard Webhooks signatures).
4. Events: tick
   - `membership.activated`
   - `membership.deactivated` (if listed)
   - `membership.updated`
   - `payment.succeeded`
   - `payment.failed`
5. Save, then copy the **signing secret** (starts with `ws_`). This is `WHOP_WEBHOOK_SECRET`.

---

## 4. Set the secrets

```bash
fly secrets set WHOP_API_KEY=… WHOP_PLAN_ID=plan_… WHOP_PRODUCT_ID=prod_… WHOP_WEBHOOK_SECRET=ws_…
```

On your computer, put the same in `.env`. Whop can't reach `localhost`, so to
test webhooks locally use a tunnel (e.g. `cloudflared tunnel --url http://localhost:8080`)
and point a second webhook at it.

---

## 5. Test it

1. In Whop, use the webhook's menu → **send a test event**. Admin → Setup
   check → "Last webhook received" updates. (A test event for a made-up
   membership is stored as "not linked". That's fine.)
2. Create a **promo code** for 100% off (Whop → your product → promo codes), so
   a test purchase costs nothing.
3. In a private window, sign up a test account → **Membership** → **Become a
   member** → Whop checkout → use the promo code → you come back to Mugibot
   and the Membership tab shows **Member** with the `mem_…` ID.
4. If that test account has connected Discord, it now has the `Member` role.
5. On Whop, cancel the test membership with immediate effect. The account
   shows "Membership ended" and the Discord role is removed.

---

## Who sees what

- Admin → **Whop memberships** lists every membership Whop has told Mugibot
  about. "not linked" means someone paid but hasn't connected it to an account yet.
- Admin → **Members** → **Link Whop** links a membership to an account by its
  `mem_…` ID (find it in Whop's dashboard under your members/customers).
- **Refresh Whop** re-reads one member's membership from Whop. Mugibot also
  re-checks memberships past their renewal date every hour, in case a webhook
  was missed.
- **Free access:** set a member's plan to `comped` on the admin console. A lapsed
  Whop membership doesn't take free access away.
- **Deleting an account** (by the member or an admin) cancels their Whop
  membership straight away.

## Without the API key

If you only set `WHOP_WEBHOOK_SECRET` and `WHOP_CHECKOUT_URL` (your product's
public Whop page), people buy on that page. The webhook still updates accounts
when it can match them, but per-member checkout links, linking memberships by
ID and the hourly re-check need `WHOP_API_KEY`. Set the API key.
