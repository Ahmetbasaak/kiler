# Kiler – Evdeki Yiyecek Takibi (PWA)

A free, Turkish-language pantry tracker that installs on the iPhone home screen. Hosting on GitHub Pages and data on Supabase, both free tier, no credit card.

**Features:** quick +/− buttons · search · categories & locations · optional expiry dates (warnings 3 days ahead) · low-stock alerts that feed an automatic shopping list · history page with charts · one shared household login · live sync between phones · Power BI / Alteryx access.

Total setup time: about 20 minutes. Do the steps in order.

---

## 1. Supabase (the database) — ~8 min

1. Go to <https://supabase.com> → **Start your project** → sign up (GitHub or e-mail).
2. **New project** → pick a name (e.g. `kiler`), set a database password (save it), choose the region closest to you (e.g. *Frankfurt*), plan **Free**.
3. When the project is ready, open **SQL Editor → New query**, paste the full contents of `supabase/schema.sql`, click **Run**. It should say *Success*.
4. **Authentication → Users → Add user → Create new user**: enter the shared household e-mail and a password, tick **Auto Confirm User**. This is the one login you and your wife both use.
5. **Authentication → Sign In / Providers** (or *Settings*): turn **off** "Allow new users to sign up", so nobody else can create an account.
6. **Project Settings → API**: copy the **Project URL** and the **anon public** key.
7. Open `config.js` in this folder and paste both values in.

## 2. GitHub Pages (the hosting) — ~7 min

1. Sign up at <https://github.com>, create a **new repository** (e.g. `kiler`, *Public*).
2. Upload everything in this folder (drag and drop in the web UI: **Add file → Upload files**), including the `icons` folder. Commit.
3. **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder `/ (root)`, Save.
4. After ~1 minute your app is live at `https://<github-username>.github.io/kiler/`.

> The `anon` key in `config.js` is meant to be public. Your data is protected by the login and the row-level security rules in the SQL, not by hiding the key. Use a strong password for the household account.

## 3. Install on the iPhone — ~1 min per phone

1. Open the link **in Safari** (must be Safari, not Chrome).
2. Tap **Share ▸ Add to Home Screen ▸ Add**.
3. Open it from the new "Kiler" icon and sign in once. It stays signed in.

## Using it

- **Stok:** `+` / `−` next to each item. Tap the name to edit. Big green `+` adds a new item. If you search for something that doesn't exist, a button offers to add it.
- **Azalan ürünler:** set "Azalma uyarısı (en az)" on an item, e.g. 2. When quantity ≤ 2 it shows an "Azaldı" tag and appears on the **Alışveriş** tab automatically. **Aldım** adds the bought quantity back to stock. The **Paylaş** button sends the list via WhatsApp/Messages.
- **SKT:** optional date per item. Items within 3 days (or past) are highlighted.
- **Geçmiş:** daily consumption/addition chart, most consumed items, consumption by category, recent movements (7/30/90 days).
- **Ayarlar:** add/delete locations and categories, export stock as CSV, sign out.

## Power BI / Alteryx

Everything is in Postgres. Two ready views are provided:

- `v_stok` – current stock (product, category, location, quantity, expiry, days left)
- `v_hareketler` – every add/consume event (date, product, category, change, type)

**Connect:**

1. In Supabase click **Connect** (top bar) → **Session pooler** and copy the host, port, user and database. (Use the pooler: the direct host is IPv6-only on the free plan.)
2. **Power BI Desktop:** Get Data → *PostgreSQL database* → server `host:port`, database `postgres` → credentials from the pooler string + your database password → pick `v_stok` and `v_hareketler`.
3. **Alteryx:** Input Data → *PostgreSQL* (ODBC/Npgsql) with the same details.
4. **Python:** `psycopg2` / `sqlalchemy` with the same connection string.

Optional: the bottom of `schema.sql` has a commented block to create a **read-only** `powerbi_reader` user, so your reporting tool never holds the admin password.

## Good to know (free-tier limits)

- Supabase pauses a free project after **7 days of no activity**. Daily use prevents this. If it ever pauses, press *Restore* in the dashboard; no data is lost.
- Free database size (500 MB) is far more than a household will ever use.
- Stock changes need internet; the app shell opens offline but shows a warning.
- iOS web apps cannot send reliable push notifications for free without extra setup, so alerts are shown inside the app (red/amber banners and the Alışveriş tab badge).

## Updating the app

Edit files in the GitHub repo (or re-upload them). Phones pick up changes the next time they open the app online (close and reopen it once).

## Files

```
index.html  styles.css  app.js  config.js   app code (no build step)
manifest.webmanifest  sw.js  icons/          install + offline support
supabase/schema.sql                          database, security, views
```
