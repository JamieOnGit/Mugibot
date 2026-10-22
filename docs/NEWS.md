# Release news: what's coming out, when, and where

Mugibot's **News** is about releases: which stores are dropping what, and on
which day. It covers everything worth being ready for because more people want
it than there's stock of: trading cards, consoles, collectibles.

News comes from two places:

| Source | How |
|---|---|
| **Admins** | Admin → **News** → Add news: a title, a link, the stores, the release date |
| **News feeds** | RSS and Atom feeds of news sites, read every 15 minutes. Only entries about a release of something hyped become news |

It shows up in three places:

- the Discord server's **`#news`** channel, one post per item;
- every member's dashboard, under **Drops → 📰 News**: what's coming up
  (soonest first) and the latest news;
- **📅 Coming up**, posted in `#news` each morning: what's released in the next
  14 days.

---

## Admins' own news

Admin → **News** → **Add news**:

- **Title**: e.g. `Pokémon TCG: Ascended Heroes — pre-orders`.
- **Link** (optional): the announcement, or the store's page.
- **Release date** (optional): the day in Sydney. With a date, it's in
  **Coming up** and in the morning's digest.
- **Category**: Trading cards, Consoles & games, Collectibles or Other. Left
  on "Guess from the title", Mugibot picks one.
- **Stores dropping it**: tick each one. That's Mugibot's own stores, plus the
  other big Australian ones (Myer, Harvey Norman, JB Hi-Fi, Officeworks,
  Costco, Woolworths, Coles, Game Traders, Mighty Ape…).
- **Summary** (optional).
- **📣 Post to `#news`**: posts it straight away.

The post looks like this:

> **📰 Pokémon TCG: Ascended Heroes — pre-orders 14 Nov at EB Games, BIG W**
> 📅 Release: Sat 14 Nov 2026 · 🏬 Stores: EB Games, BIG W · Category · Source · **Read more**

Each item in the list has **Post now** (or **Post again**), **Edit** and
**Delete**. Deleting an item doesn't remove a post that's already in Discord.

---

## News feeds

Mugibot starts with these feeds, all switched on. Each was checked with a real
read when it was added:

| Feed | Covers |
|---|---|
| PokéBeach (front-page news) | The Pokémon TCG: sets, products, dates |
| Nintendo Life | Nintendo, Switch 2 |
| Push Square | PlayStation |
| Pure Xbox | Xbox |
| IGN | Games and consoles |
| Press Start | Australian: when pre-orders open, and at which stores here |
| Stevivor | Australian: release dates and pre-orders |

PokeGuardian (no feed) and the official Pokémon, Wizards of the Coast and
Lorcana sites (no working feed, or no answer to servers) were checked and left
out.

### How a feed is read

- Every **15 minutes**, give or take a minute, so the feeds stay spread out.
  Only one request goes to a website at a time, with the monitor's gap between
  requests.
- **As Mugibot**, with its own user agent, like the monitor's sweeps.
- With a **conditional request** (ETag / If-Modified-Since). When the website
  answers "nothing new" (304), nothing is downloaded and nothing changes.
- When a read goes wrong (an error, a refusal, a web page instead of a feed),
  the error is shown and the feed **backs off**: 30 minutes, then 1 hour, 2
  hours, at most 4 hours. Once it works, it goes back to every 15 minutes.
- A feed's **first read only sets the scene**, like a sweep's first search.
  What's in it already is kept (on the dashboard, and in the digest) but not
  posted. Only entries that turn up after that are posted. The first read
  starts again when the feed's link or words change, or when it's switched back
  on. An entry published more than two days ago isn't posted either, and one
  read posts 5 entries at most.
- **Once.** An entry already in the news isn't news again: the same entry in its
  feed (its guid or id), or the same link from any feed.

### What counts as news

An entry becomes news when both of these are true:

1. **It names a hyped product**, in its title or summary. The defaults:
   Pokémon, One Piece, Riftbound, Gundam, Lorcana, Dragon Ball, Magic: The
   Gathering (MTG), Yu-Gi-Oh, Digimon, Union Arena, Star Wars Unlimited,
   Flesh and Blood, Weiss Schwarz, Switch 2, Nintendo, PlayStation, PS5, PS6,
   DualSense, Xbox, Steam Deck, LEGO, amiibo, Labubu, Pop Mart and
   Collector's Edition. A feed's own **words** are added to these.
2. **Its title reads like a release**: pre-order(s), pre-sale, release date,
   releases, launches, launching, coming soon / to stores / to Australia,
   arrives, restock, reprint, drop(s), available from / now, on sale, out now,
   hits shelves, in stores, back in stock, goes live… It has to be the title:
   summaries mention "launch" or "released" in passing (patch notes, reviews,
   podcasts). A trailer dropping or a price dropping doesn't count.

A console's name alone (Nintendo, PlayStation, Xbox, Switch 2, PS5, PS6) only
counts when the title is about the console itself or its stock — a console,
controller, bundle, edition, amiibo, OLED or Slim model, Series X / S, a restock,
"in stock", "sold out", or "Switch 2 pre-orders" / "PS5 Pro launches" — not one of
its games ("Mario Kart World launches on Switch 2" isn't news here: it doesn't
sell out). A game's Collector's Edition still counts.

Never when the title names something that can't be bought and sold on:
Pokémon GO, TCG Pocket, TCG Live, Pokémon Unite / Sleep / Masters, PS Plus,
Game Pass, Switch Online, eShop, DLC, a demo.

Then Mugibot reads these out of the entry where it can tell for sure:

- **The date**: "November 14", "14 Nov 2026", "14th of November",
  "14/11/2026" (Australian order) or "2026-11-14". This is midnight in Sydney
  on that day. A date with no year is the next one after the entry was written.
  Numbers that are part of a name aren't days ("Switch 2 October update", "Top
  10 May releases").
- **The stores**: Mugibot's own stores by name (and what people call them: "Big
  W", "JB HiFi", "Toys R Us"), plus the other big Australian ones. "Target"
  only counts next to a word that makes it a store ("at Target", "Target's",
  "Target exclusive"), not "hit its target".
- **The category**: trading cards, consoles & games, collectibles or other.

### Adding a feed

Admin → **News** → **News feeds**: paste the feed's link (RSS or Atom; most
news sites have one at `/feed`, `/rss` or `/feeds/latest`), and give it a name
and words if you like. It's read straight away, so you can see whether it
works. Its first read is kept, not posted.

**Words** is a comma-separated list. Each word is added to the hyped products
for that feed. A word starting with `-` leaves out entries with that word in
the title. For example, `funko, -plush` adds Funko and leaves out plush toys.
**Words…** changes them later. On each feed you'll also find:

- **On**: off stops reading it. Switching it back on starts with a first read
  again.
- **Last read**: when it was last read, and either what that read found
  ("25 entries, 3 about releases, 1 new, 1 posted") or what went wrong and when
  it tries again.
- **Found**: how many news items it has brought.
- **Check**: reads it now. **⟳ Check feeds now** reads every feed that's on.
- **Remove**: stops reading it. The news it found stays.

---

## The `#news` channel

Mugibot posts in the server's `#news`:

- the one saved by **Set up #news** (Admin → News) or **Set up store
  channels** (Drops → Settings → Discord alert channels, which sets it up with
  the rest);
- otherwise a text or announcement channel named `news`, found by name. Emoji
  are fine: `📰┃news` counts;
- otherwise one the bot makes in the **Mugibot alerts** category. This needs the
  **Manage Channels** permission. You can also make the channel yourself and
  press the button again.

Posts never ping @everyone or @here, even when a feed's title contains them.
To ping a role, put its ID in **Role to ping** and press **Set up #news**. To
stop pinging, empty the box and press it again. The store channels' role isn't
used for `#news`, because news isn't a drop.

The bot needs **View Channel**, **Send Messages** and **Embed Links** there.

---

## 📅 Coming up (the morning digest)

Each morning at **8:31 in Sydney**, Mugibot posts **📅 Coming up** in `#news`.
It lists every news item with a release date in the next 14 days (today
included), soonest first, with its day, link and stores:

> **Sat 14 Nov** — [Pokémon TCG: Ascended Heroes — pre-orders](…) · EB Games, BIG W

- It's posted **once a day**, and only when there's something coming up.
- If Discord is down, it keeps trying until noon.
- **Post 📅 Coming up now** (Admin → News) posts it whenever you like. That
  doesn't count as the day's digest, so the morning one still goes out.

It doesn't ping anyone.

---

## On a server of your own

The feeds are read and the digest is posted while the monitor is on
(`MONITOR_ENABLED`, on by default). Tests never read a real website: their
feeds are fixtures on the test's own computer (`test/news.test.js`).
