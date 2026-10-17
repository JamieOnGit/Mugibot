# Chrome Web Store: an extension that updates itself

Chrome only updates an extension by itself when it comes from the **Chrome Web
Store**. Copies downloaded from the dashboard (loaded with "Load unpacked")
never do, so members have to replace them for every new version. Chrome
doesn't allow any other way of updating automatically.

So: publish Mugibot on the Chrome Web Store as **Unlisted**. Only people with
the link can install it; it doesn't show up in searches. You do this once:

- **Part A** (about 30 minutes, then Google's review): publish it.
- **Part B** (about 15 minutes): let GitHub publish every new version by itself.

After that, when a change to the extension is merged on GitHub, the new
version goes to the Chrome Web Store, Google reviews it, and Chrome updates
every member's copy within a few hours. Nobody downloads or replaces anything.

Until your listing is approved, everything keeps working as it does now.

---

## A. Publish it (once)

### 1. Developer account

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   and sign in with the Google account that should own the extension.
2. Accept the agreement and pay the **one-time US$5** registration fee.
3. **Account** page: set the **Publisher name** (e.g. "Mugibot") and verify the
   contact email. Members see the publisher name on the listing.

### 2. The package

Mugibot **Admin** → **Setup check** → **Browser extension** → **Download the
Chrome Web Store package**. It's built for your site's addresses. Don't unzip
it.

### 3. New item

Developer Dashboard → **New item** → upload that zip. Then fill in each tab.

**Store listing**

| Field | What to put |
|---|---|
| Description | Paste the text below |
| Category | Shopping |
| Language | English |
| Store icon | Upload `docs/store/icon-128.png` (in this repository) |
| Screenshots | Upload `docs/store/screenshot-1.png` and `docs/store/screenshot-2.png` (1280×800) |
| Small promo tile | Upload `docs/store/promo-440x280.png` |
| Official URL / Homepage | `https://mugibot.com` |
| Support URL | `https://mugibot.com` |

Description:

> Mugibot is the browser extension for Mugibot members. It needs a Mugibot account.
>
> • ⚡ Buy: from your Mugibot dashboard or a Discord restock ping, it takes you straight to the store's checkout with the product in your bag, following each store's own steps.
> • Fills in your delivery details and your saved card at checkout, and stops at the store's final button for you to press.
> • Auto-checkout (optional, off until you switch it on and agree in your Mugibot dashboard): for items you arm, each with a max price, it checks out by itself when they drop and places the order within your limits — once per arming. It stops at your bank's or a store's check.
> • Checks your own watchlist at stores that refuse checks from servers, from your browser, about once a minute (you can switch this off).
>
> Your card is saved in this browser, encrypted, and is never sent to Mugibot's servers in a form they can read. If you choose to back it up to your account (so a new install doesn't need it typed in again), it's locked in your browser first with a card passphrase only you know. It never solves CAPTCHAs, skips queues or hides who it is.

**Privacy practices**

- **Single purpose:** `Checkout assist and restock checks for the user's own Mugibot account.`
- **Permission justifications:**
  - `storage`: Keeps the connection to the user's Mugibot account, their watchlist and their encrypted card in this browser.
  - `alarms`: Runs the user's own restock checks about once a minute, the update check, and keeps listening for the items the user armed for Auto-checkout.
  - Host permissions (the store sites): Fills in checkout on the supported stores' pages when the user presses ⚡ Buy (or an item they armed for Auto-checkout drops), and checks the user's own watchlist items there.
  - Host permissions (payment provider sites): The card boxes on those stores' checkout pages are hosted by payment providers; the extension types the user's saved card into them.
  - Host permissions (mugibot.com): Connects the extension to the user's Mugibot account.
- **Remote code:** "No, I am not using remote code." (The store steps it downloads are data, not code.)
- **Data usage:** tick
  - Personally identifiable information (name, email, phone, delivery address: filled in at checkout)
  - Financial and payment information (the card: kept in the browser; if the user turns on card backup, only a copy encrypted in the browser with the user's own passphrase is sent to the user's Mugibot account, which can't decrypt it)
  - Authentication information (the connection to the user's Mugibot account)
  - Website content (it reads the supported stores' pages to check stock and find checkout buttons)

  and certify the three statements (not sold, only used for the extension's purpose, not used for credit decisions).
- **Privacy policy URL:** `https://mugibot.com/privacy`

**Distribution**

- **Visibility: Unlisted.**
- Regions: Australia (or all regions).

### 4. Submit for review

Press **Submit for review**. Google usually takes a day to a few days. If they
email questions, the answers are on this page. If it's rejected, the email
says why; fix that and submit again.

### 5. Once it's approved

1. Open your listing and copy its address: `https://chromewebstore.google.com/detail/…`.
2. Mugibot **Admin** → **Setup check** → **Browser extension** → paste it into
   **Chrome Web Store link** → **Save link**.

From then on:

- The dashboard's **Extension** tab shows **Add to Chrome** first.
- Every downloaded copy shows **NEW** on its icon, and its popup says **Get
  Mugibot from the Chrome Web Store**, with a **Remove this copy** button.
- With both copies installed, the downloaded one stays out of the way (its icon
  shows **OLD**), so nothing happens twice.
- Admin → Setup check → Browser extension shows how many members are on each copy.

### 6. Tell members (once)

Paste in your Discord:

> **Mugibot is now on the Chrome Web Store: it updates itself from now on.** Once:
> 1. Click the Mugibot icon in Chrome → **Open the Chrome Web Store** → **Add to Chrome**.
> 2. On mugibot.com → **Extension** → **Connect this browser**.
> 3. Click the Mugibot icon → **Add your card** and save it.
> 4. Click the old Mugibot icon (it says **OLD**) → **Remove this copy**.
>
> Works in Chrome, Edge and Brave.

The new copy is a separate install, so the connection (step 2) and the card
(step 3) are done once more.

---

## B. Automatic publishing (once)

So that every new version reaches the Chrome Web Store with no clicking. It
uses a Google "service account": a robot login that can only publish your
extension.

1. **Google Cloud project:** go to the [Google Cloud console](https://console.cloud.google.com),
   sign in with the same Google account, and create a project (e.g. "mugibot-publishing").
2. **Turn on the API:** in that project, search for **Chrome Web Store API** →
   **Enable**.
3. **Service account:** **IAM & Admin** → **Service accounts** → **Create
   service account**. Name it "mugibot-publisher". Skip the optional steps →
   **Done**.
4. **Its key:** open the service account → **Keys** → **Add key** → **Create
   new key** → **JSON** → **Create**. A `.json` file downloads. Treat it like a
   password: it can publish your extension.
5. **Allow it to publish:** Chrome Web Store Developer Dashboard → **Account** →
   **Service account** → add the service account's email (it ends in
   `.iam.gserviceaccount.com`) → **Save**.
6. **Two IDs:**
   - **Publisher ID:** on the Developer Dashboard's **Account** page (it's
     also the long code in the dashboard's address, after `/devconsole/`).
   - **Item ID:** the 32 letters at the end of your listing's address (also
     shown under the extension's name in the dashboard).
7. **GitHub:** open your repository → **Settings** → **Secrets and variables**
   → **Actions**.
   - **Secrets** tab → **New repository secret**: name `CWS_SERVICE_ACCOUNT_KEY`,
     value: open the `.json` file in TextEdit/Notepad and paste all of it.
   - **Variables** tab → **New repository variable**, three times:
     - `CWS_PUBLISHER_ID` = your publisher ID
     - `CWS_ITEM_ID` = your item ID
     - `SITE_URL` = `https://mugibot.com`

That's it. After the next merge, GitHub → **Actions** → the latest run →
**publish-extension** says either "Submitted v…" or "The Chrome Web Store
already has v…". Every change to the extension comes with a higher version in
`extension/manifest.json`, which is what triggers a new submission.

**How long until members have it:** Google reviews each version (usually
within a day or two), then Chrome updates members' copies within a few hours.
Store steps (each retailer's flow) don't need any of this: they come from your
server and reach everyone straight away.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| publish-extension: "Not publishing to the Chrome Web Store yet: set …" | Part B, step 7: the named setting is missing. |
| "Google refused the service account key" | Paste the whole `.json` file again as `CWS_SERVICE_ACCOUNT_KEY`. |
| HTTP 403 / "permission" from the Chrome Web Store | Part B, step 5: add the service account's email in the Developer Dashboard, and check `CWS_PUBLISHER_ID`. |
| HTTP 404 | Check `CWS_ITEM_ID` and `CWS_PUBLISHER_ID`. |
| "runs extension v…, this is v…" | The deploy hadn't finished. Re-run the job: GitHub → Actions → the run → **Re-run jobs**. |
| A member has two Mugibot icons | The one showing **OLD** is the downloaded copy: click it → **Remove this copy**. |
| Members on Edge | **Add to Chrome** works in Edge too (it asks to allow extensions from other stores). |
