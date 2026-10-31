/* Kiler - evdeki yiyecek takibi (PWA). Saf JS, derleme gerektirmez. */
(() => {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const autoLogin = !!(cfg.AUTO_LOGIN_EMAIL && cfg.AUTO_LOGIN_PASSWORD);
  const $ = (s, r = document) => r.querySelector(s);
  const app = $("#app");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n).toLocaleString("tr-TR", { maximumFractionDigits: 2 });
  const lower = (s) => String(s || "").toLocaleLowerCase("tr");
  const UNITS = ["adet", "paket", "kg", "gr", "lt", "ml", "kutu", "şişe", "kavanoz", "demet"];
  const EXPIRY_SOON_DAYS = 3;

  // ---------- Durum ----------
  const S = {
    session: null, tab: "stok", loaded: false,
    items: [], cats: [], locs: [], extras: [],
    q: "", fLoc: null, fCat: null, fSpecial: null, // fSpecial: 'low' | 'expiring' | null
    histDays: 30, moves: [], movesLoaded: false,
    online: navigator.onLine,
  };
  let sb = null;
  let pending = 0, reloadTimer = null, reloadWanted = false;

  // ---------- Yardımcılar ----------
  function toast(msg, ms = 2200) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
  }
  const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  function daysLeft(dateStr) {
    if (!dateStr) return null;
    const [y, m, d] = dateStr.split("-").map(Number);
    return Math.round((new Date(y, m - 1, d) - todayStart()) / 86400000);
  }
  const isLow = (i) => Number(i.min_quantity) > 0 && Number(i.quantity) <= Number(i.min_quantity);
  const isExpiring = (i) => { const d = daysLeft(i.expiry_date); return d !== null && d <= EXPIRY_SOON_DAYS && Number(i.quantity) > 0; };
  const catOf = (id) => S.cats.find((c) => c.id === id);
  const locOf = (id) => S.locs.find((l) => l.id === id);
  const isStandalone = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

  function expiryBadge(i) {
    const d = daysLeft(i.expiry_date);
    if (d === null) return "";
    if (d < 0) return `<span class="badge bad">SKT geçti</span>`;
    if (d === 0) return `<span class="badge bad">Bugün bitiyor</span>`;
    if (d <= EXPIRY_SOON_DAYS) return `<span class="badge warn">${d} gün kaldı</span>`;
    return `<span class="badge">SKT ${new Date(i.expiry_date).toLocaleDateString("tr-TR", { day: "numeric", month: "short" })}</span>`;
  }

  // ---------- Başlangıç ----------
  async function init() {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    window.addEventListener("online", () => { S.online = true; render(); scheduleReload(); });
    window.addEventListener("offline", () => { S.online = false; render(); });

    const placeholder = !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("PROJE-KODUNUZ") || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.includes("BURAYA");
    if (placeholder) { app.innerHTML = `<div class="login"><h1>Kurulum gerekli</h1><p>config.js dosyasına Supabase adresini ve anahtarını yapıştırın (README.md'ye bakın).</p></div>`; return; }
    if (!window.supabase) { app.innerHTML = `<div class="login"><h1>Bağlantı yok</h1><p>Uygulama ilk açılışta internet gerektirir.</p></div>`; return; }

    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    const { data } = await sb.auth.getSession();
    S.session = data.session;
    sb.auth.onAuthStateChange((_e, session) => {
      const was = !!S.session; S.session = session;
      if (session && !was) start(); else if (!session && was) { stopRealtime(); S.loaded = false; render(); }
    });
    // İsteğe bağlı otomatik giriş (config.js içinde AUTO_LOGIN_EMAIL / AUTO_LOGIN_PASSWORD doluysa)
    if (!S.session && autoLogin) {
      app.innerHTML = `<div class="login"><img src="icons/icon-192.png" alt=""><h1>Kiler</h1><p>Açılıyor…</p></div>`;
      const { data: d, error } = await sb.auth.signInWithPassword({ email: cfg.AUTO_LOGIN_EMAIL, password: cfg.AUTO_LOGIN_PASSWORD });
      if (!error && d.session) { if (!S.session) { S.session = d.session; start(); } return; } // olay zaten tetiklediyse tekrar başlatma
      return renderLogin(S.online ? "Otomatik giriş başarısız: bilgileri elle girin." : "İnternet bağlantısı yok.");
    }
    if (S.session) start(); else render();
  }

  let channel = null;
  function stopRealtime() { if (channel) { sb.removeChannel(channel); channel = null; } }

  async function start() {
    render();
    await loadAll();
    stopRealtime();
    channel = sb.channel("kiler-sync");
    ["items", "shopping_extra", "categories", "locations"].forEach((t) =>
      channel.on("postgres_changes", { event: "*", schema: "public", table: t }, () => { scheduleReload(); })
    );
    channel.subscribe();
    document.addEventListener("visibilitychange", () => { if (!document.hidden && S.session) scheduleReload(0); });
  }

  function scheduleReload(delay = 350) {
    if (pending > 0) { reloadWanted = true; return; }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => { await loadAll(); if (S.tab === "gecmis") loadMoves(); }, delay);
  }

  async function loadAll() {
    if (!sb || !S.session) return;
    const [i, c, l, e] = await Promise.all([
      sb.from("items").select("*").order("name"),
      sb.from("categories").select("*").order("name"),
      sb.from("locations").select("*").order("sort").order("name"),
      sb.from("shopping_extra").select("*").order("created_at"),
    ]);
    const err = i.error || c.error || l.error || e.error;
    if (err) { toast("Veri yüklenemedi: " + err.message, 4000); S.loaded = true; render(); return; }
    S.items = i.data; S.cats = c.data; S.locs = l.data; S.extras = e.data; S.loaded = true;
    render();
  }

  // ---------- Çizim ----------
  function render() {
    if (!S.session) return renderLogin();
    const lowCount = S.items.filter(isLow).length + S.extras.length;
    app.innerHTML = `
      <div class="screen">${!S.online ? `<div class="offline">Çevrimdışısınız — değişiklikler kaydedilemez</div>` : ""}${
        !S.loaded ? `<div class="empty"><div class="big">⏳</div>Yükleniyor…</div>` :
        S.tab === "stok" ? viewStock() : S.tab === "alisveris" ? viewShopping() : S.tab === "gecmis" ? viewHistory() : viewSettings()
      }</div>
      ${S.tab === "stok" && S.loaded ? `<button class="fab" data-act="add" aria-label="Ürün ekle">+</button>` : ""}
      <nav class="tabbar">
        ${tab("stok", "🥫", "Stok")}
        ${tab("alisveris", "🛒", "Alışveriş", lowCount)}
        ${tab("gecmis", "📊", "Geçmiş")}
        ${tab("ayar", "⚙️", "Ayarlar")}
      </nav>`;
    if (S.tab === "gecmis" && S.loaded) drawHistory();
  }
  const tab = (id, ic, label, n = 0) =>
    `<button data-tab="${id}" class="${S.tab === id ? "on" : ""}"><span class="ic">${ic}</span>${label}${n ? `<span class="dot">${n}</span>` : ""}</button>`;

  function renderLogin(msg = "") {
    app.innerHTML = `
      <form class="login" id="login">
        <img src="icons/icon-192.png" alt="">
        <h1>Kiler</h1>
        <p>Evdeki yiyeceklerin takibi</p>
        ${isIOS() && !isStandalone() ? `<div class="hint">📲 Safari'de <b>Paylaş</b> ▸ <b>Ana Ekrana Ekle</b> diyerek uygulama gibi kullanın.</div>` : ""}
        <label class="field"><span>E-posta</span><input name="email" type="email" autocomplete="username" autocapitalize="none" required></label>
        <label class="field"><span>Şifre</span><input name="password" type="password" autocomplete="current-password" required></label>
        <div class="err" id="loginErr">${esc(msg)}</div>
        <button class="btn" type="submit">Giriş yap</button>
      </form>`;
    $("#login").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      $("#loginErr").textContent = "";
      const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
      if (error) $("#loginErr").textContent = error.message.includes("Invalid") ? "E-posta veya şifre hatalı." : error.message;
    });
  }

  // ----- Stok -----
  function filteredItems() {
    const q = lower(S.q.trim());
    return S.items.filter((i) => {
      if (q && !lower(i.name).includes(q)) return false;
      if (S.fLoc && i.location_id !== S.fLoc) return false;
      if (S.fCat && i.category_id !== S.fCat) return false;
      if (S.fSpecial === "low" && !isLow(i)) return false;
      if (S.fSpecial === "expiring" && !isExpiring(i)) return false;
      return true;
    });
  }

  function itemRow(i) {
    const c = catOf(i.category_id), l = locOf(i.location_id);
    return `<div class="row" data-id="${i.id}">
      <div class="emoji">${esc(c?.emoji || "📦")}</div>
      <div class="info" data-act="edit">
        <div class="name">${esc(i.name)}</div>
        <div class="meta">${l ? `<span class="badge">${esc(l.name)}</span>` : ""}${isLow(i) ? `<span class="badge warn">Azaldı</span>` : ""}${expiryBadge(i)}</div>
      </div>
      <div class="stepper">
        <button data-act="dec" aria-label="Azalt">−</button>
        <div class="qty ${Number(i.quantity) === 0 ? "zero" : ""}" data-act="edit">${fmt(i.quantity)}<small>${esc(i.unit)}</small></div>
        <button data-act="inc" aria-label="Artır">+</button>
      </div>
    </div>`;
  }

  function stockBody() {
    const list = filteredItems();
    let body = "";
    if (!S.items.length) {
      body = `<div class="empty"><div class="big">🥕</div><b>Kiler boş görünüyor</b><br>Sağ alttaki + ile ilk ürünü ekleyin.</div>`;
    } else if (!list.length) {
      body = `<div class="empty"><div class="big">🔍</div>Sonuç yok.${S.q.trim() ? `<br><br><button class="btn secondary" data-act="quickadd" style="max-width:260px;margin:auto">“${esc(S.q.trim())}” ekle</button>` : ""}</div>`;
    } else {
      // kategoriye göre grupla
      const groups = new Map();
      for (const i of list) { const k = i.category_id || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
      const keys = [...groups.keys()].sort((a, b) => (catOf(a)?.name || "~").localeCompare(catOf(b)?.name || "~", "tr"));
      for (const k of keys) {
        const c = catOf(k);
        const rows = groups.get(k).sort((a, b) => a.name.localeCompare(b.name, "tr")).map(itemRow).join("");
        body += `<div class="group-title">${esc(c?.emoji || "📦")} ${esc(c?.name || "Kategorisiz")}</div><div class="list">${rows}</div>`;
      }
    }
    return body;
  }

  function viewStock() {
    const low = S.items.filter(isLow).length, exp = S.items.filter(isExpiring).length;
    return `
      <div class="topbar"><div><h1>Kiler</h1><div class="sub">${S.items.length} ürün çeşidi</div></div></div>
      ${(low || exp) && !S.q ? `<div class="banner">
        ${low ? `<button data-act="goLow">🛒 ${low} ürün azaldı</button>` : ""}
        ${exp ? `<button class="red" data-act="goExp">⏳ ${exp} ürünün SKT'si yakın</button>` : ""}</div>` : ""}
      <div class="search"><input id="q" type="search" inputmode="search" placeholder="Ürün ara…" value="${esc(S.q)}" autocomplete="off"></div>
      <div class="chips">
        <button class="chip ${!S.fLoc && !S.fSpecial ? "on" : ""}" data-act="fclear">Tümü</button>
        ${low ? `<button class="chip alert ${S.fSpecial === "low" ? "on" : ""}" data-act="fspecial" data-v="low">Azalan (${low})</button>` : ""}
        ${exp ? `<button class="chip alert ${S.fSpecial === "expiring" ? "on" : ""}" data-act="fspecial" data-v="expiring">SKT yakın (${exp})</button>` : ""}
        ${S.locs.map((l) => `<button class="chip ${S.fLoc === l.id ? "on" : ""}" data-act="floc" data-v="${l.id}">${esc(l.name)}</button>`).join("")}
      </div>
      <div class="chips">
        ${S.cats.map((c) => `<button class="chip ${S.fCat === c.id ? "on" : ""}" data-act="fcat" data-v="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`).join("")}
      </div>
      <div id="stockBody">${stockBody()}</div>`;
  }

  // ----- Alışveriş -----
  function shoppingLines() {
    return S.items.filter(isLow).sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }
  function viewShopping() {
    const auto = shoppingLines();
    const empty = !auto.length && !S.extras.length;
    return `
      <div class="topbar"><div><h1>Alışveriş</h1><div class="sub">Azalan ürünler otomatik eklenir</div></div>
        ${!empty ? `<button class="chip" data-act="share">Paylaş</button>` : ""}</div>
      <form class="add-line" id="extraForm"><input id="extraName" placeholder="Listeye ekle… (örn. Zeytinyağı)" autocomplete="off"><button type="submit">Ekle</button></form>
      ${empty ? `<div class="empty"><div class="big">✅</div>Alınacak bir şey yok.</div>` : ""}
      ${auto.length ? `<h2>Azalanlar</h2><div class="list">${auto.map((i) => `
        <div class="row" data-id="${i.id}">
          <div class="emoji">${esc(catOf(i.category_id)?.emoji || "📦")}</div>
          <div class="info" data-act="edit"><div class="name">${esc(i.name)}</div>
            <div class="meta"><span class="badge warn">${Number(i.quantity) === 0 ? "Bitti" : `Kaldı: ${fmt(i.quantity)} ${esc(i.unit)}`}</span><span class="badge">Min: ${fmt(i.min_quantity)}</span></div></div>
          <button class="buy" data-act="bought">Aldım</button>
        </div>`).join("")}</div>` : ""}
      ${S.extras.length ? `<h2>Diğer</h2><div class="list">${S.extras.map((x) => `
        <div class="row" data-xid="${x.id}"><div class="emoji">📝</div><div class="info"><div class="name">${esc(x.name)}</div></div>
          <button class="buy" data-act="xdone">Tamam</button></div>`).join("")}</div>` : ""}`;
  }

  // ----- Geçmiş -----
  function viewHistory() {
    return `
      <div class="topbar"><div><h1>Geçmiş</h1><div class="sub">Tüketim ve ekleme özeti</div></div></div>
      <div class="seg">${[7, 30, 90].map((d) => `<button data-act="range" data-v="${d}" class="${S.histDays === d ? "on" : ""}">${d} gün</button>`).join("")}</div>
      <div id="histBody">${S.movesLoaded ? "" : `<div class="empty"><div class="big">⏳</div>Yükleniyor…</div>`}</div>`;
  }

  async function loadMoves() {
    if (!sb) return;
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    let all = [], from = 0;
    for (;;) {
      const { data, error } = await sb.from("movements").select("*").gte("created_at", since).order("created_at", { ascending: false }).range(from, from + 999);
      if (error) { toast("Geçmiş yüklenemedi: " + error.message, 4000); break; }
      all = all.concat(data); if (data.length < 1000) break; from += 1000;
    }
    S.moves = all; S.movesLoaded = true;
    if (S.tab === "gecmis") drawHistory();
  }

  function drawHistory() {
    const host = $("#histBody"); if (!host || !S.movesLoaded) return;
    const n = S.histDays;
    const start = todayStart(); start.setDate(start.getDate() - (n - 1));
    const moves = S.moves.filter((m) => new Date(m.created_at) >= start);
    if (!moves.length) { host.innerHTML = `<div class="empty"><div class="big">📭</div>Bu aralıkta hareket yok.<br>Stok değiştikçe burada görünecek.</div>`; return; }

    const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const days = [];
    for (let k = 0; k < n; k++) { const d = new Date(start); d.setDate(start.getDate() + k); days.push({ d, out: 0, in: 0 }); }
    const idx = new Map(days.map((x, i) => [dayKey(x.d), i]));
    let totOut = 0, totIn = 0;
    const byItem = new Map(), byCat = new Map();
    for (const m of moves) {
      const i = idx.get(dayKey(new Date(m.created_at))); const dl = Number(m.delta);
      if (dl < 0) {
        const v = -dl; if (i !== undefined) days[i].out += v; totOut += v;
        byItem.set(m.item_name, (byItem.get(m.item_name) || 0) + v);
        const ck = m.category_name || "Kategorisiz"; byCat.set(ck, (byCat.get(ck) || 0) + v);
      } else { if (i !== undefined) days[i].in += dl; totIn += dl; }
    }

    // SVG sütun grafik
    const W = 600, H = 170, padL = 28, padB = 20, padT = 8;
    const max = Math.max(1, ...days.map((x) => Math.max(x.in, x.out)));
    const niceMax = Math.ceil(max / (max > 10 ? 5 : 1)) * (max > 10 ? 5 : 1);
    const cw = (W - padL) / n, bw = Math.max(1.5, Math.min(14, cw * 0.38));
    const y = (v) => padT + (H - padT - padB) * (1 - v / niceMax);
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Günlük tüketim ve ekleme grafiği">`;
    for (const t of [0, 0.5, 1]) {
      const v = niceMax * t; svg += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="currentColor" stroke-opacity=".12"/><text x="0" y="${y(v) + 3}">${fmt(v)}</text>`;
    }
    const every = n <= 7 ? 1 : n <= 30 ? 5 : 15;
    days.forEach((x, i) => {
      const cx = padL + cw * i + cw / 2;
      if (x.out) svg += `<rect x="${cx - bw - 0.5}" y="${y(x.out)}" width="${bw}" height="${y(0) - y(x.out)}" rx="2" fill="#e5484d"/>`;
      if (x.in) svg += `<rect x="${cx + 0.5}" y="${y(x.in)}" width="${bw}" height="${y(0) - y(x.in)}" rx="2" fill="#2f9e62"/>`;
      if (i % every === 0 || i === n - 1 && n <= 7) svg += `<text x="${cx}" y="${H - 5}" text-anchor="middle">${x.d.getDate()}.${x.d.getMonth() + 1}</text>`;
    });
    svg += `</svg>`;

    const bars = (map, limit) => {
      const arr = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
      const mx = arr[0]?.[1] || 1;
      return arr.map(([k, v]) => `<div class="hbar"><div class="lbl">${esc(k)}</div><div><div class="bar" style="width:${(v / mx) * 100}%"></div></div><div class="val">${fmt(v)}</div></div>`).join("");
    };

    const recent = moves.slice(0, 25).map((m) => {
      const dl = Number(m.delta), t = new Date(m.created_at);
      return `<div class="mv"><div>${esc(m.item_name)}<small>${t.toLocaleDateString("tr-TR", { day: "numeric", month: "short" })} ${t.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}${m.location_name ? " · " + esc(m.location_name) : ""}</small></div>
        <b class="${dl < 0 ? "out" : "in"}">${dl > 0 ? "+" : "−"}${fmt(Math.abs(dl))} ${esc(m.unit || "")}</b></div>`;
    }).join("");

    host.innerHTML = `
      <div class="cards">
        <div class="stat out"><b>${fmt(totOut)}</b><span>Tüketilen (son ${n} gün)</span></div>
        <div class="stat in"><b>${fmt(totIn)}</b><span>Eklenen</span></div>
      </div>
      <div class="panel"><h4>Günlük hareket</h4>${svg}
        <div class="legend"><span><i style="background:#e5484d"></i>Tüketilen</span><span><i style="background:#2f9e62"></i>Eklenen</span></div></div>
      ${byItem.size ? `<div class="panel"><h4>En çok tüketilen ürünler</h4>${bars(byItem, 8)}</div>` : ""}
      ${byCat.size ? `<div class="panel"><h4>Kategoriye göre tüketim</h4>${bars(byCat, 10)}</div>` : ""}
      <div class="panel"><h4>Son hareketler</h4>${recent}</div>`;
  }

  // ----- Ayarlar -----
  function viewSettings() {
    return `
      <div class="topbar"><div><h1>Ayarlar</h1><div class="sub">${esc(S.session?.user?.email || "")}</div></div></div>
      <h2>Konumlar</h2>
      <div class="list">${S.locs.map((l) => `<div class="srow"><span>${esc(l.name)}</span><button class="x" data-act="delLoc" data-v="${l.id}">Sil</button></div>`).join("")}</div>
      <button class="btn secondary" style="margin-top:10px" data-act="addLoc">+ Konum ekle</button>
      <h2>Kategoriler</h2>
      <div class="list">${S.cats.map((c) => `<div class="srow"><span>${esc(c.emoji)} ${esc(c.name)}</span><button class="x" data-act="delCat" data-v="${c.id}">Sil</button></div>`).join("")}</div>
      <button class="btn secondary" style="margin-top:10px" data-act="addCat">+ Kategori ekle</button>
      <h2>Veri</h2>
      <button class="btn secondary" data-act="export">Stoğu CSV olarak indir</button>
      <h2>Hesap</h2>
      ${autoLogin ? "" : `<button class="btn danger" data-act="logout">Çıkış yap</button>`}
      <p style="text-align:center;color:var(--muted);font-size:12px;margin-top:20px">Kiler · Verileriniz Supabase'de saklanır</p>`;
  }

  // ---------- Sheet / form ----------
  function closeSheet() { $("#sheet-root").innerHTML = ""; }
  function askForm({ title, fields, submit = "Kaydet", extra = [] }) {
    return new Promise((resolve) => {
      const root = $("#sheet-root");
      const fieldHtml = (f) => {
        if (f.type === "select") return `<label class="field"><span>${f.label}</span><select name="${f.name}">${f.options.map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(f.value ?? "") ? "selected" : ""}>${esc(o.l)}</option>`).join("")}</select></label>`;
        const attrs = f.type === "number" ? `inputmode="decimal" step="any" min="0"` : "";
        return `<label class="field"><span>${f.label}</span><input name="${f.name}" type="${f.type || "text"}" ${attrs} value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder || "")}" ${f.required ? "required" : ""} autocomplete="off"></label>`;
      };
      // iki sütunlu satırlar için: f.pair === true ise bir sonrakiyle yan yana
      let html = "", buf = [];
      for (const f of fields) {
        if (f.half) { buf.push(fieldHtml(f)); if (buf.length === 2) { html += `<div class="two">${buf.join("")}</div>`; buf = []; } }
        else { if (buf.length) { html += `<div class="two">${buf.join("")}</div>`; buf = []; } html += fieldHtml(f); }
      }
      if (buf.length) html += `<div class="two">${buf.join("")}</div>`;
      root.innerHTML = `<div class="backdrop"></div><form class="sheet"><h3>${esc(title)}</h3>${html}
        <button class="btn" type="submit">${esc(submit)}</button>
        ${extra.map((x) => `<button type="button" class="btn ${x.danger ? "danger" : "secondary"}" data-extra="${x.id}">${esc(x.label)}</button>`).join("")}
        <button type="button" class="btn ghost" data-cancel>Vazgeç</button></form>`;
      const form = $("form.sheet", root);
      const done = (v) => { closeSheet(); resolve(v); };
      $(".backdrop", root).onclick = () => done(null);
      $("[data-cancel]", form).onclick = () => done(null);
      form.querySelectorAll("[data-extra]").forEach((b) => (b.onclick = () => done({ __action: b.dataset.extra })));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const o = {}; new FormData(form).forEach((v, k) => (o[k] = typeof v === "string" ? v.trim() : v));
        done(o);
      });
      const first = form.querySelector("input:not([type=date]), select"); if (first && !fields.some((f) => f.noFocus)) setTimeout(() => first.focus(), 60);
    });
  }

  async function itemForm(item, prefillName = "") {
    const editing = !!item;
    const r = await askForm({
      title: editing ? "Ürünü düzenle" : "Yeni ürün",
      submit: editing ? "Kaydet" : "Ekle",
      extra: editing ? [{ id: "delete", label: "Ürünü sil", danger: true }] : [],
      fields: [
        { name: "name", label: "Ürün adı", required: true, value: item?.name ?? prefillName, placeholder: "örn. Domates" },
        { name: "quantity", label: "Miktar", type: "number", half: true, value: item?.quantity ?? 1, required: true },
        { name: "unit", label: "Birim", type: "select", half: true, value: item?.unit ?? "adet", options: UNITS.map((u) => ({ v: u, l: u })) },
        { name: "category_id", label: "Kategori", type: "select", value: item?.category_id ?? S.fCat ?? "", options: [{ v: "", l: "— Seçilmedi —" }, ...S.cats.map((c) => ({ v: c.id, l: `${c.emoji} ${c.name}` }))] },
        { name: "location_id", label: "Konum", type: "select", value: item?.location_id ?? S.fLoc ?? "", options: [{ v: "", l: "— Seçilmedi —" }, ...S.locs.map((l) => ({ v: l.id, l: l.name }))] },
        { name: "min_quantity", label: "Azalma uyarısı (en az)", type: "number", half: true, value: item?.min_quantity ?? 0, placeholder: "0 = kapalı" },
        { name: "expiry_date", label: "Son kullanma (isteğe bağlı)", type: "date", half: true, value: item?.expiry_date ?? "", noFocus: true },
      ],
    });
    if (!r) return;
    if (r.__action === "delete") {
      if (!confirm(`“${item.name}” silinsin mi?`)) return;
      const { error } = await sb.from("items").delete().eq("id", item.id);
      if (error) return toast("Silinemedi: " + error.message, 3500);
      S.items = S.items.filter((x) => x.id !== item.id); render(); return toast("Silindi");
    }
    const row = {
      name: r.name, quantity: Number(String(r.quantity).replace(",", ".")) || 0, unit: r.unit,
      category_id: r.category_id ? Number(r.category_id) : null, location_id: r.location_id ? Number(r.location_id) : null,
      min_quantity: Number(String(r.min_quantity).replace(",", ".")) || 0, expiry_date: r.expiry_date || null,
    };
    const q = editing ? sb.from("items").update(row).eq("id", item.id) : sb.from("items").insert(row);
    const { error } = await q;
    if (error) return toast("Kaydedilemedi: " + error.message, 3500);
    toast(editing ? "Güncellendi" : "Eklendi"); await loadAll();
  }

  // ---------- Eylemler ----------
  async function adjust(id, delta) {
    const it = S.items.find((x) => x.id === id); if (!it) return;
    const newQ = Math.max(0, Number(it.quantity) + delta);
    if (newQ === Number(it.quantity)) return;
    it.quantity = newQ; render();
    if (navigator.vibrate) navigator.vibrate(8);
    pending++;
    const { error } = await sb.rpc("adjust_item", { p_id: id, p_delta: delta });
    pending--;
    if (error) { toast("Kaydedilemedi: " + error.message, 3500); reloadWanted = true; }
    if (pending === 0 && reloadWanted) { reloadWanted = false; scheduleReload(150); }
  }

  async function onAction(act, el, ev) {
    const row = el.closest("[data-id]"); const id = row?.dataset.id;
    switch (act) {
      case "inc": return adjust(id, 1);
      case "dec": return adjust(id, -1);
      case "edit": return itemForm(S.items.find((x) => x.id === id));
      case "add": return itemForm(null);
      case "quickadd": { const n = S.q.trim(); S.q = ""; return itemForm(null, n); }
      case "fclear": S.fLoc = null; S.fSpecial = null; S.fCat = null; return render();
      case "floc": S.fLoc = S.fLoc === +el.dataset.v ? null : +el.dataset.v; return render();
      case "fcat": S.fCat = S.fCat === +el.dataset.v ? null : +el.dataset.v; return render();
      case "fspecial": S.fSpecial = S.fSpecial === el.dataset.v ? null : el.dataset.v; return render();
      case "goLow": S.tab = "alisveris"; return render();
      case "goExp": S.fSpecial = "expiring"; return render();
      case "range": S.histDays = +el.dataset.v; return render();
      case "bought": {
        const it = S.items.find((x) => x.id === id); if (!it) return;
        const sug = Math.max(Number(it.min_quantity) * 2 - Number(it.quantity), 1);
        const r = await askForm({ title: `${it.name} — kaç ${it.unit} aldınız?`, submit: "Stoğa ekle", fields: [{ name: "n", label: "Miktar", type: "number", value: sug, required: true }] });
        if (!r) return; const n = Number(String(r.n).replace(",", "."));
        if (n > 0) { await adjust(id, n); toast(`${it.name} +${fmt(n)}`); }
        return;
      }
      case "xdone": { const xid = el.closest("[data-xid]").dataset.xid; S.extras = S.extras.filter((x) => String(x.id) !== xid); render(); const { error } = await sb.from("shopping_extra").delete().eq("id", xid); if (error) { toast("Silinemedi", 3000); loadAll(); } return; }
      case "share": {
        const lines = [...shoppingLines().map((i) => `• ${i.name}`), ...S.extras.map((x) => `• ${x.name}`)];
        const text = "Alışveriş listesi:\n" + lines.join("\n");
        if (navigator.share) { try { await navigator.share({ text }); } catch {} }
        else { try { await navigator.clipboard.writeText(text); toast("Liste kopyalandı"); } catch { toast("Paylaşılamadı"); } }
        return;
      }
      case "addLoc": { const r = await askForm({ title: "Yeni konum", fields: [{ name: "name", label: "Ad", required: true, placeholder: "örn. Balkon" }] }); if (!r) return;
        const { error } = await sb.from("locations").insert({ name: r.name, sort: S.locs.length + 1 }); if (error) toast(error.message.includes("duplicate") ? "Bu konum zaten var" : error.message, 3000); return loadAll(); }
      case "addCat": { const r = await askForm({ title: "Yeni kategori", fields: [{ name: "emoji", label: "Simge (emoji)", value: "🍽️", half: true }, { name: "name", label: "Ad", required: true, half: true }] }); if (!r) return;
        const { error } = await sb.from("categories").insert({ name: r.name, emoji: r.emoji || "📦" }); if (error) toast(error.message.includes("duplicate") ? "Bu kategori zaten var" : error.message, 3000); return loadAll(); }
      case "delLoc": { const l = locOf(+el.dataset.v); if (!confirm(`“${l.name}” silinsin mi? Ürünler silinmez, konumsuz kalır.`)) return;
        await sb.from("locations").delete().eq("id", l.id); if (S.fLoc === l.id) S.fLoc = null; return loadAll(); }
      case "delCat": { const c = catOf(+el.dataset.v); if (!confirm(`“${c.name}” silinsin mi? Ürünler silinmez, kategorisiz kalır.`)) return;
        await sb.from("categories").delete().eq("id", c.id); if (S.fCat === c.id) S.fCat = null; return loadAll(); }
      case "export": return exportCsv();
      case "logout": if (confirm("Çıkış yapılsın mı?")) await sb.auth.signOut(); return;
    }
  }

  function exportCsv() {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Ürün", "Kategori", "Konum", "Miktar", "Birim", "Minimum", "Son kullanma"];
    const rows = S.items.map((i) => [i.name, catOf(i.category_id)?.name, locOf(i.location_id)?.name, i.quantity, i.unit, i.min_quantity, i.expiry_date].map(q).join(";"));
    const blob = new Blob(["﻿" + [head.map(q).join(";"), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "kiler-stok.csv"; document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- Olaylar ----------
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t) { S.tab = t.dataset.tab; window.scrollTo(0, 0); render(); if (S.tab === "gecmis") loadMoves(); return; }
    const a = e.target.closest("[data-act]");
    if (a && !e.target.closest("#sheet-root")) { onAction(a.dataset.act, a, e); }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "q") { S.q = e.target.value; const b = $("#stockBody"); if (b) b.innerHTML = stockBody(); }
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id === "extraForm") {
      e.preventDefault();
      const inp = $("#extraName"); const name = inp.value.trim(); if (!name) return;
      inp.value = "";
      const { error } = await sb.from("shopping_extra").insert({ name });
      if (error) toast("Eklenemedi: " + error.message, 3000); else loadAll();
    }
  });

  init();
})();
