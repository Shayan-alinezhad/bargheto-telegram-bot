// Cloudflare Worker Telegram Bot + D1
// در تنظیمات Worker فقط یک D1 binding با نام bargheto بسازید.

const SOURCE_URL = "https://baboliha.ir/";
const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
let lastSourceDebug = {
  status: 0, htmlLength: 0, textLength: 0, sample: "",
  startCount: 0, locationCount: 0, babolCount: 0,
  finalUrl: "", redirectCount: 0, rawSample: ""
};

const CITIES = [
  "آمل", "بابل", "بابلسر", "بهشهر", "جویبار", "ساری", "سوادکوه",
  "سوادکوه شمالی", "سیمرغ", "فریدون کنار", "قائمشهر", "میاندرود", "نکا", "گلوگاه"
];

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "🔎 جستجوی منطقه" }, { text: "🏙 انتخاب و ذخیره شهر" }],
    [{ text: "⚡ خاموشی‌های امروز" }, { text: "📅 خاموشی‌های فردا" }],
    [{ text: "⭐ شهر ذخیره‌شده" }, { text: "🗑 حذف شهر ذخیره‌شده" }],
    [{ text: "🧪 تست دریافت اطلاعات" }, { text: "ℹ️ راهنما" }]
  ],
  resize_keyboard: true,
  is_persistent: true,
  one_time_keyboard: false,
  input_field_placeholder: "یک گزینه از منوی ربات انتخاب کنید…"
};

const CITY_KEYBOARD = {
  inline_keyboard: chunk(CITIES, 3).map(row =>
    row.map(city => ({ text: city, callback_data: `save_city:${city}` }))
  )
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!env.bargheto) {
      return json({ ok: false, error: "D1 binding با نام bargheto تنظیم نشده است." }, 500);
    }

    await ensureDatabase(env.bargheto);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!isAdminAuthorized(request, env)) return adminUnauthorized();

      if (request.method === "GET" && url.pathname === "/admin") {
        return adminPanelResponse();
      }
      if (request.method === "GET" && url.pathname === "/admin/api/users") {
        return adminUsersResponse(url, env.bargheto);
      }
      if (request.method === "GET" && url.pathname === "/admin/export.csv") {
        return adminCsvResponse(url, env.bargheto);
      }
      return new Response("Not Found", { status: 404 });
    }

    // این آدرس را یک بار در مرورگر باز کنید تا Webhook ثبت شود:
    // https://YOUR-WORKER.workers.dev/setup
    if (request.method === "GET" && url.pathname === "/setup") {
      if (!isAdminAuthorized(request, env)) return adminUnauthorized();
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return json({ ok: false, error: "BOT_TOKEN و WEBHOOK_SECRET تنظیم نشده‌اند." }, 500);
      }
      const webhookUrl = `${url.origin}/webhook/${env.WEBHOOK_SECRET}`;
      const bot = await telegram(env, "getMe", {});
      await telegram(env, "deleteWebhook", { drop_pending_updates: true });
      const result = await telegram(env, "setWebhook", {
        url: webhookUrl,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true
      });
      await telegram(env, "setMyCommands", {
        commands: [
          { command: "start", description: "باز کردن منوی اصلی" },
          { command: "help", description: "راهنمای ربات" },
          { command: "mycity", description: "نمایش شهر ذخیره‌شده" },
          { command: "setcity", description: "انتخاب و ذخیره شهر" },
          { command: "test", description: "تست دریافت اطلاعات" }
        ]
      });
      return json({
        ok: true,
        bot: bot.result?.username,
        webhook: result,
        webhook_url: webhookUrl,
        next_step: "حالا در تلگرام /start را ارسال کنید."
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const userCount = await env.bargheto.prepare("SELECT COUNT(*) AS count FROM bot_users").first();
      return json({ ok: true, users: userCount?.count || 0, time: new Date().toISOString() });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Baboliha Telegram Bot is running. Open /setup once.", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    if (request.method === "POST" && env.WEBHOOK_SECRET && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      ctx.waitUntil(handleUpdate(update, env));
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
};

function isAdminAuthorized(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return constantTimeEqual(username, env.ADMIN_USERNAME || "admin") &&
      constantTimeEqual(password, env.ADMIN_PASSWORD);
  } catch {
    return false;
  }
}

function constantTimeEqual(a, b) {
  const first = String(a);
  const second = String(b);
  let mismatch = first.length ^ second.length;
  const length = Math.max(first.length, second.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (first.charCodeAt(i % Math.max(1, first.length)) || 0) ^
      (second.charCodeAt(i % Math.max(1, second.length)) || 0);
  }
  return mismatch === 0;
}

function adminUnauthorized() {
  return new Response("برای ورود به پنل، نام کاربری و رمز عبور مدیر را وارد کنید.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Bargheto Admin", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function adminUsersResponse(url, db) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const city = (url.searchParams.get("city") || "").trim().slice(0, 50);
  const conditions = [];
  const bindings = [];

  if (q) {
    const like = `%${q}%`;
    conditions.push(`(
      CAST(telegram_id AS TEXT) LIKE ? OR
      COALESCE(username, '') LIKE ? OR
      COALESCE(first_name, '') LIKE ? OR
      COALESCE(city, '') LIKE ?
    )`);
    bindings.push(like, like, like, like);
  }
  if (city) {
    conditions.push("city = ?");
    bindings.push(city);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const statement = db.prepare(`
    SELECT telegram_id, username, first_name, city, created_at, updated_at
    FROM bot_users
    ${where}
    ORDER BY datetime(updated_at) DESC, telegram_id DESC
    LIMIT 500
  `);
  const usersResult = bindings.length
    ? await statement.bind(...bindings).all()
    : await statement.all();

  const stats = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN city IS NOT NULL AND TRIM(city) <> '' THEN 1 ELSE 0 END) AS with_city,
      SUM(CASE WHEN city IS NULL OR TRIM(city) = '' THEN 1 ELSE 0 END) AS without_city,
      SUM(CASE WHEN datetime(updated_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS active_24h
    FROM bot_users
  `).first();

  const cityResult = await db.prepare(`
    SELECT city, COUNT(*) AS user_count
    FROM bot_users
    WHERE city IS NOT NULL AND TRIM(city) <> ''
    GROUP BY city
    ORDER BY user_count DESC, city ASC
  `).all();

  return json({
    ok: true,
    users: usersResult.results || [],
    stats: {
      total: Number(stats?.total || 0),
      withCity: Number(stats?.with_city || 0),
      withoutCity: Number(stats?.without_city || 0),
      active24h: Number(stats?.active_24h || 0)
    },
    cities: cityResult.results || [],
    filters: { q, city },
    generatedAt: new Date().toISOString()
  });
}

async function adminCsvResponse(url, db) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const city = (url.searchParams.get("city") || "").trim().slice(0, 50);
  const conditions = [];
  const bindings = [];
  if (q) {
    const like = `%${q}%`;
    conditions.push(`(CAST(telegram_id AS TEXT) LIKE ? OR COALESCE(username, '') LIKE ? OR COALESCE(first_name, '') LIKE ? OR COALESCE(city, '') LIKE ?)`);
    bindings.push(like, like, like, like);
  }
  if (city) {
    conditions.push("city = ?");
    bindings.push(city);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const statement = db.prepare(`
    SELECT telegram_id, username, first_name, city, created_at, updated_at
    FROM bot_users ${where}
    ORDER BY datetime(updated_at) DESC
  `);
  const result = bindings.length ? await statement.bind(...bindings).all() : await statement.all();
  const rows = result.results || [];
  const csv = [
    ["telegram_id", "username", "first_name", "favorite_city", "created_at", "updated_at"],
    ...rows.map(row => [row.telegram_id, row.username, row.first_name, row.city, row.created_at, row.updated_at])
  ].map(row => row.map(csvCell).join(",")).join("\n");

  return new Response("\uFEFF" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="bargheto-users.csv"',
      "Cache-Control": "no-store"
    }
  });
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function adminPanelResponse() {
  return new Response(adminPanelHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
    }
  });
}

function adminPanelHtml() {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>پنل مدیریت برق تو</title>
  <style>
    :root{color-scheme:light;--canvas:#fff;--surface:#f9f8f7;--surface2:#f0efed;--text:#2c2c2b;--muted:#74716c;--border:#e6e5e3;--blue:#2783de;--blueSoft:#e5f2fc;--green:#46a171;--greenSoft:#e8f1ec;--orange:#d5803b;--orangeSoft:#fbebde;--shadow:0 1px 2px rgba(0,0,0,.05),0 4px 12px rgba(0,0,0,.04)}
    *{box-sizing:border-box} body{margin:0;background:var(--canvas);color:var(--text);font-family:Tahoma,Arial,sans-serif;font-size:16px;line-height:1.5}
    button,input,select{font:inherit} button,a,input,select{outline:none} :focus-visible{box-shadow:0 0 0 3px rgba(39,131,222,.25)}
    .shell{max-width:1120px;margin:auto;padding:32px 24px 56px}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:32px}
    .brand{display:flex;align-items:center;gap:14px}.logo{width:48px;height:48px;border-radius:12px;background:var(--blue);display:grid;place-items:center;color:#fff;font-size:24px;box-shadow:var(--shadow)}
    h1{font-size:28px;line-height:1.25;margin:0 0 4px}.subtitle{margin:0;color:var(--muted);font-size:14px}
    .github{color:var(--blue);text-decoration:none;font-size:14px;font-weight:700;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:#fff}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
    .stat{border:1px solid var(--border);border-radius:12px;padding:18px;background:#fff;min-height:112px}.stat.primary{background:var(--blueSoft);border-color:#c9e4f8}.stat.positive{background:var(--greenSoft);border-color:#d4e8dc}.stat.attention{background:var(--orangeSoft);border-color:#f0d8c4}
    .stat-label{color:var(--muted);font-size:14px}.stat-value{display:block;font-size:30px;line-height:1.2;margin-top:12px;font-weight:800}.stat-note{color:var(--muted);font-size:12px;margin-top:4px}
    .controls{display:grid;grid-template-columns:minmax(240px,1fr) 220px auto auto;gap:12px;padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--surface);margin-bottom:24px}
    .field{position:relative}.field input,.field select{width:100%;height:46px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--text);padding:0 14px}.field input{padding-right:42px}.search-icon{position:absolute;right:14px;top:11px;color:var(--muted)}
    .btn{height:46px;border-radius:8px;border:1px solid var(--border);padding:0 16px;background:#fff;color:var(--text);cursor:pointer;font-weight:700;white-space:nowrap}.btn:hover{background:var(--surface2)}.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}.btn.primary:hover{filter:brightness(.96)}
    .layout{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:24px;align-items:start}.panel{border:1px solid var(--border);border-radius:12px;background:#fff;overflow:hidden}.panel-head{display:flex;justify-content:space-between;align-items:center;padding:18px 20px;border-bottom:1px solid var(--border)}.panel-head h2{font-size:18px;margin:0}.result-count{font-size:13px;color:var(--muted)}
    .table-wrap{overflow:auto}.users{width:100%;border-collapse:collapse;min-width:760px}.users th,.users td{text-align:right;padding:14px 16px;border-bottom:1px solid var(--border);vertical-align:middle}.users th{font-size:13px;color:var(--muted);font-weight:700;background:var(--surface);position:sticky;top:0}.users tr:last-child td{border-bottom:0}.users tbody tr:hover{background:#fbfbfa}
    .person{display:flex;align-items:center;gap:10px}.avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--blueSoft);color:var(--blue);font-weight:800}.name{font-weight:700}.username,.id,.date{font-size:13px;color:var(--muted);direction:ltr;text-align:right}.city{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:999px;background:var(--greenSoft);color:#2d7651;font-size:13px;font-weight:700}.city.empty{background:var(--surface2);color:var(--muted)}
    .cities{padding:8px 20px 18px}.city-row{padding:12px 0;border-bottom:1px solid var(--border)}.city-row:last-child{border-bottom:0}.city-meta{display:flex;justify-content:space-between;font-size:14px;margin-bottom:8px}.bar{height:7px;border-radius:99px;background:var(--surface2);overflow:hidden}.bar span{display:block;height:100%;background:var(--blue);border-radius:inherit}.empty-state{padding:56px 24px;text-align:center;color:var(--muted)}.empty-icon{font-size:36px;margin-bottom:10px}.loading{opacity:.55;pointer-events:none}
    .footer{margin-top:32px;text-align:center;color:var(--muted);font-size:13px}.footer a{color:var(--blue);text-decoration:none}
    @media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}.layout{grid-template-columns:1fr}.controls{grid-template-columns:1fr 1fr}.controls .btn{width:100%}}
    @media(max-width:560px){.shell{padding:24px 16px 40px}.topbar{align-items:flex-start}.github{display:none}h1{font-size:23px}.stats{gap:10px}.stat{padding:14px;min-height:98px}.stat-value{font-size:25px}.controls{grid-template-columns:1fr;padding:12px}.panel-head{padding:16px}.cities{padding-inline:16px}}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--canvas:#191919;--surface:#202020;--surface2:#383836;--text:#fff;--muted:rgba(255,255,255,.65);--border:rgba(255,255,255,.2);--blue:#5e9fe8;--blueSoft:rgba(94,159,232,.12);--green:#72bc8f;--greenSoft:rgba(114,188,143,.12);--orange:#de9255;--orangeSoft:rgba(222,146,85,.12)}.stat,.panel,.field input,.field select,.btn,.github{background:#202020}.users tbody tr:hover{background:#252525}}
  </style>
</head>
<body>
  <main class="shell" id="app">
    <header class="topbar">
      <div class="brand"><div class="logo" aria-hidden="true">⚡</div><div><h1>پنل مدیریت برق تو</h1><p class="subtitle">کاربران ربات و شهرهای موردعلاقه</p></div></div>
      <a class="github" href="https://github.com/Shayan-alinezhad" target="_blank" rel="noreferrer">GitHub · Cloner</a>
    </header>

    <section class="stats" aria-label="آمار کاربران">
      <article class="stat primary"><span class="stat-label">کل کاربران</span><strong class="stat-value" id="total">—</strong><div class="stat-note">عضو ثبت‌شده در D1</div></article>
      <article class="stat positive"><span class="stat-label">شهر انتخاب‌شده</span><strong class="stat-value" id="withCity">—</strong><div class="stat-note">کاربر دارای مکان موردعلاقه</div></article>
      <article class="stat attention"><span class="stat-label">بدون شهر</span><strong class="stat-value" id="withoutCity">—</strong><div class="stat-note">در انتظار انتخاب شهر</div></article>
      <article class="stat"><span class="stat-label">فعال در ۲۴ ساعت</span><strong class="stat-value" id="active24h">—</strong><div class="stat-note">براساس آخرین تعامل</div></article>
    </section>

    <section class="controls" aria-label="فیلتر کاربران">
      <label class="field"><span class="search-icon">⌕</span><input id="query" type="search" autocomplete="off" placeholder="جست‌وجوی نام، آیدی، یوزرنیم یا شهر" aria-label="جست‌وجوی کاربران"></label>
      <label class="field"><select id="cityFilter" aria-label="فیلتر شهر"><option value="">همه شهرها</option></select></label>
      <button class="btn primary" id="refresh" type="button">به‌روزرسانی</button>
      <button class="btn" id="export" type="button">دریافت CSV</button>
    </section>

    <section class="layout">
      <div class="panel">
        <div class="panel-head"><h2>فهرست کاربران</h2><span class="result-count" id="resultCount">در حال دریافت…</span></div>
        <div class="table-wrap"><table class="users"><thead><tr><th>کاربر</th><th>شناسه تلگرام</th><th>شهر موردعلاقه</th><th>عضویت</th><th>آخرین فعالیت</th></tr></thead><tbody id="userRows"></tbody></table><div class="empty-state" id="empty" hidden><div class="empty-icon">⌕</div><strong>کاربری پیدا نشد</strong><div>فیلترها را تغییر دهید و دوباره تلاش کنید.</div></div></div>
      </div>
      <aside class="panel"><div class="panel-head"><h2>توزیع شهرها</h2></div><div class="cities" id="cityStats"><div class="empty-state">در حال دریافت…</div></div></aside>
    </section>
    <footer class="footer">طراحی و برنامه‌نویسی توسط <a href="https://github.com/Shayan-alinezhad" target="_blank" rel="noreferrer">Cloner</a></footer>
  </main>
  <script>
    (function(){
      var app=document.getElementById('app'),query=document.getElementById('query'),cityFilter=document.getElementById('cityFilter'),timer;
      function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
      function digits(v){return new Intl.NumberFormat('fa-IR').format(Number(v||0))}
      function formatDate(v){if(!v)return '—';var d=new Date(String(v).replace(' ','T')+'Z');return isNaN(d)?esc(v):new Intl.DateTimeFormat('fa-IR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tehran'}).format(d)}
      function initials(user){var source=user.first_name||user.username||'?';return esc(source.trim().charAt(0).toUpperCase())}
      function renderUsers(users){var body=document.getElementById('userRows'),empty=document.getElementById('empty');body.innerHTML='';empty.hidden=users.length>0;users.forEach(function(u){var tr=document.createElement('tr');var username=u.username?'@'+u.username:'بدون یوزرنیم';var city=u.city?'<span class="city">⌖ '+esc(u.city)+'</span>':'<span class="city empty">انتخاب نشده</span>';tr.innerHTML='<td><div class="person"><span class="avatar">'+initials(u)+'</span><div><div class="name">'+esc(u.first_name||'بدون نام')+'</div><div class="username">'+esc(username)+'</div></div></div></td><td><div class="id">'+esc(u.telegram_id)+'</div></td><td>'+city+'</td><td><div class="date">'+formatDate(u.created_at)+'</div></td><td><div class="date">'+formatDate(u.updated_at)+'</div></td>';body.appendChild(tr)})}
      function renderCities(cities,total){var box=document.getElementById('cityStats');box.innerHTML='';if(!cities.length){box.innerHTML='<div class="empty-state">هنوز شهری ثبت نشده است.</div>';return}cities.forEach(function(c){var pct=total?Math.round(Number(c.user_count)*100/total):0;var row=document.createElement('div');row.className='city-row';row.innerHTML='<div class="city-meta"><strong>'+esc(c.city)+'</strong><span>'+digits(c.user_count)+' کاربر</span></div><div class="bar"><span style="width:'+Math.max(3,pct)+'%"></span></div>';box.appendChild(row)})}
      function syncCities(cities){var selected=cityFilter.value;cityFilter.innerHTML='<option value="">همه شهرها</option>';cities.forEach(function(c){var option=document.createElement('option');option.value=c.city;option.textContent=c.city+' · '+digits(c.user_count);cityFilter.appendChild(option)});cityFilter.value=selected}
      async function load(){app.classList.add('loading');var params=new URLSearchParams();if(query.value.trim())params.set('q',query.value.trim());if(cityFilter.value)params.set('city',cityFilter.value);try{var response=await fetch('/admin/api/users?'+params.toString(),{cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);var data=await response.json();document.getElementById('total').textContent=digits(data.stats.total);document.getElementById('withCity').textContent=digits(data.stats.withCity);document.getElementById('withoutCity').textContent=digits(data.stats.withoutCity);document.getElementById('active24h').textContent=digits(data.stats.active24h);document.getElementById('resultCount').textContent=digits(data.users.length)+' نتیجه';renderUsers(data.users);renderCities(data.cities,data.stats.withCity);syncCities(data.cities)}catch(error){document.getElementById('resultCount').textContent='خطا در دریافت اطلاعات';document.getElementById('userRows').innerHTML='<tr><td colspan="5"><div class="empty-state">ارتباط با دیتابیس برقرار نشد.</div></td></tr>'}finally{app.classList.remove('loading')}}
      query.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(load,350)});cityFilter.addEventListener('change',load);document.getElementById('refresh').addEventListener('click',load);document.getElementById('export').addEventListener('click',function(){var params=new URLSearchParams();if(query.value.trim())params.set('q',query.value.trim());if(cityFilter.value)params.set('city',cityFilter.value);location.href='/admin/export.csv?'+params.toString()});load();
    })();
  </script>
</body>
</html>`;
}

async function ensureDatabase(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS bot_users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      city TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function handleUpdate(update, env) {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
      return;
    }

    const message = update.message;
    if (!message?.chat?.id || !message.text) return;

    await upsertUser(env.bargheto, message.from);

    const chatId = message.chat.id;
    const text = normalize(message.text.replace(/@\w+$/, "")).trim();

    if (text === "/start" || text.startsWith("/start ") ||
        text === "/help" || text.startsWith("/help ") || text === "ℹ️ راهنما") {
      await sendMessage(env, chatId,
        "⚡ <b>ربات قطعی برق مازندران</b>\n\n" +
        "ابتدا شهر خود را انتخاب و ذخیره کنید. سپس می‌توانید خاموشی‌های امروز و فردا را ببینید.\n\n" +
        "برای جست‌وجوی محله یا خیابان نیز نام آن را مستقیم ارسال کنید.\n\n" +
        "👨‍💻 این ربات توسط <b>Cloner</b> برنامه‌نویسی شده است.\n" +
        "🔗 <a href=\"https://github.com/Shayan-alinezhad\">GitHub: Shayan-alinezhad</a>",
        MAIN_KEYBOARD
      );
      return;
    }

    if (text === "🏙 انتخاب و ذخیره شهر" || text === "/setcity") {
      await sendMessage(env, chatId, "🏙 شهر خود را انتخاب کنید:", CITY_KEYBOARD);
      return;
    }

    if (text === "⭐ شهر ذخیره‌شده" || text === "/mycity") {
      const city = await getSavedCity(env.bargheto, message.from.id);
      if (!city) {
        await sendMessage(env, chatId, "هنوز شهری ذخیره نکرده‌اید.", CITY_KEYBOARD);
      } else {
        await sendMessage(env, chatId, `⭐ شهر ذخیره‌شده شما: <b>${escapeHtml(city)}</b>`, MAIN_KEYBOARD);
      }
      return;
    }

    if (text === "🗑 حذف شهر ذخیره‌شده" || text === "/deletecity") {
      await env.bargheto.prepare(
        "UPDATE bot_users SET city = NULL, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?"
      ).bind(message.from.id).run();
      await sendMessage(env, chatId, "🗑 شهر ذخیره‌شده حذف شد.", MAIN_KEYBOARD);
      return;
    }

    if (text === "🔎 جستجوی منطقه") {
      await sendMessage(env, chatId,
        "🔎 نام محله، خیابان یا روستا را در پیام بعدی بنویسید؛ مثلاً:\n<code>بلوار مادر</code>",
        { force_reply: true, selective: true, input_field_placeholder: "نام منطقه…" }
      );
      return;
    }

    const outages = await getOutages();

    if (text === "🧪 تست دریافت اطلاعات" || text === "/test") {
      if (!outages.length) {
        await sendMessage(env, chatId, "⚠️ سایت دریافت شد، اما رکوردی استخراج نشد. ساختار سایت احتمالاً تغییر کرده است.", MAIN_KEYBOARD);
      } else {
        await sendResults(env, chatId, outages.slice(0, 5), `تست موفق — ${outages.length} رکورد استخراج شد`);
      }
      return;
    }

    if (text === "/debug") {
      const savedCity = await getSavedCity(env.bargheto, message.from.id);
      const cityResults = savedCity
        ? outages.filter(item => sameCity(item.city, savedCity))
        : [];
      const dates = [...new Set(cityResults.map(item => item.date).filter(Boolean))];
      const days = [...new Set(cityResults.map(item => item.day).filter(Boolean))];
      await sendMessage(env, chatId,
        `🛠 <b>وضعیت استخراج</b>\n` +
        `کل رکوردها: <b>${outages.length}</b>\n` +
        `وضعیت سایت: <b>HTTP ${lastSourceDebug.status || "?"}</b>\n` +
        `آدرس نهایی: <code>${escapeHtml(lastSourceDebug.finalUrl || "نامشخص")}</code>\n` +
        `تعداد انتقال: <b>${lastSourceDebug.redirectCount || 0}</b>\n` +
        `حجم HTML: <b>${lastSourceDebug.htmlLength}</b> کاراکتر\n` +
        `حجم متن: <b>${lastSourceDebug.textLength}</b> کاراکتر\n` +
        `تعداد «شروع»: <b>${lastSourceDebug.startCount || 0}</b>\n` +
        `تعداد «📍»: <b>${lastSourceDebug.locationCount || 0}</b>\n` +
        `تعداد «بابل»: <b>${lastSourceDebug.babolCount || 0}</b>\n` +
        `شهر ذخیره‌شده: <b>${escapeHtml(savedCity || "ندارد")}</b>\n` +
        `رکوردهای شهر: <b>${cityResults.length}</b>\n` +
        `تاریخ‌ها: <code>${escapeHtml(dates.join("، ") || "ندارد")}</code>\n` +
        `برچسب روز: <code>${escapeHtml(days.join("، ") || "ندارد")}</code>\n` +
        `نمونه متن: <code>${escapeHtml(lastSourceDebug.sample || "ندارد")}</code>\n` +
        `نمونه HTML: <code>${escapeHtml(lastSourceDebug.rawSample || "ندارد")}</code>`,
        MAIN_KEYBOARD
      );
      return;
    }

    if (text === "⚡ خاموشی‌های امروز" || text === "📅 خاموشی‌های فردا") {
      const day = text.includes("امروز") ? "امروز" : "فردا";
      const savedCity = await getSavedCity(env.bargheto, message.from.id);

      if (!savedCity) {
        await sendMessage(env, chatId, "ابتدا شهر خود را انتخاب و ذخیره کنید:", CITY_KEYBOARD);
        return;
      }

      // فیلتر اصلی براساس تاریخ شمسی تهران انجام می‌شود؛ برچسب امروز/فردای
      // سایت ممکن است حوالی نیمه‌شب هنوز به‌روزرسانی نشده باشد.
      const targetDate = persianDateInTehran(day === "امروز" ? 0 : 1);
      const results = outages.filter(item =>
        sameCity(item.city, savedCity) &&
        (normalizeDigits(item.date) === normalizeDigits(targetDate) ||
          searchKey(item.day) === searchKey(day))
      );

      if (!results.length) {
        await sendMessage(env, chatId,
          `برای <b>${escapeHtml(savedCity)}</b> در ${day} (${escapeHtml(targetDate)}) خاموشی ثبت‌شده‌ای پیدا نشد.\n\n` +
          `برای بررسی استخراج، دستور <code>/debug</code> را ارسال کنید.`,
          MAIN_KEYBOARD
        );
      } else {
        await sendResults(env, chatId, results.slice(0, 15), `خاموشی‌های ${day} شهر ${savedCity}`);
      }
      return;
    }

    if (text.startsWith("/city ")) {
      const city = text.slice(6).trim();
      const results = filterOutages(outages, city);
      await sendSearchResponse(env, chatId, results, `خاموشی‌های شهر ${city}`, city);
      return;
    }

    if (text.startsWith("/")) {
      await sendMessage(env, chatId, "دستور ناشناخته است. از دکمه‌های منو استفاده کنید.", MAIN_KEYBOARD);
      return;
    }

    // هر متن عادی به‌عنوان نام محله، خیابان، روستا یا شهر جست‌وجو می‌شود.
    const savedCity = await getSavedCity(env.bargheto, message.from.id);
    let results = filterOutages(outages, text);

    // اگر شهر ذخیره شده باشد، ابتدا نتایج همان شهر نمایش داده می‌شود.
    if (savedCity) {
      const localResults = results.filter(item => sameCity(item.city, savedCity));
      if (localResults.length) results = localResults;
    }

    await sendSearchResponse(env, chatId, results, "نتیجه جست‌وجو", text);
  } catch (error) {
    console.error("handleUpdate error:", error);
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) {
      await sendMessage(env, chatId, "❌ خطایی در دریافت یا پردازش اطلاعات رخ داد.", MAIN_KEYBOARD);
    }
  }
}

async function handleCallbackQuery(callback, env) {
  const chatId = callback.message?.chat?.id;
  const user = callback.from;
  if (!chatId || !user) return;

  await upsertUser(env.bargheto, user);
  await answerCallbackQuery(env, callback.id, "در حال ذخیره…");

  if (!callback.data?.startsWith("save_city:")) return;

  const city = callback.data.slice("save_city:".length);
  if (!CITIES.includes(city)) {
    await sendMessage(env, chatId, "شهر انتخاب‌شده معتبر نیست.", MAIN_KEYBOARD);
    return;
  }

  await env.bargheto.prepare(`
    UPDATE bot_users
    SET city = ?, updated_at = CURRENT_TIMESTAMP
    WHERE telegram_id = ?
  `).bind(city, user.id).run();

  await sendMessage(env, chatId,
    `✅ شهر <b>${escapeHtml(city)}</b> ذخیره شد.\nحالا خاموشی‌های امروز یا فردا را انتخاب کنید.`,
    MAIN_KEYBOARD
  );
}

async function upsertUser(db, user) {
  if (!user?.id) return;
  await db.prepare(`
    INSERT INTO bot_users (telegram_id, username, first_name, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      updated_at = CURRENT_TIMESTAMP
  `).bind(user.id, user.username || null, user.first_name || null).run();
}

async function getSavedCity(db, telegramId) {
  const row = await db.prepare(
    "SELECT city FROM bot_users WHERE telegram_id = ? LIMIT 1"
  ).bind(telegramId).first();
  return row?.city || null;
}

async function getOutages() {
  const source = await fetchSourceHtml(SOURCE_URL);
  const { response, html, finalUrl, redirectCount } = source;
  if (!response.ok) throw new Error(`Source HTTP ${response.status}`);

  // HTMLRewriter در بعضی صفحات متن عناصر تو‌در‌تو را به handler بدنه تحویل
  // نمی‌دهد. بنابراین HTML خام را می‌خوانیم و به متن قابل پردازش تبدیل می‌کنیم.
  const pageText = htmlToText(html);
  lastSourceDebug = {
    status: response.status,
    finalUrl,
    redirectCount,
    htmlLength: html.length,
    textLength: pageText.length,
    sample: sampleAround(pageText, "شروع", 450),
    startCount: countOccurrences(pageText, "شروع"),
    locationCount: countOccurrences(pageText, "📍"),
    babolCount: countOccurrences(normalize(pageText), "بابل"),
    rawSample: html.slice(0, 500).replace(/\s+/g, " ").trim()
  };

  return parseOutages(pageText);
}

async function fetchSourceHtml(initialUrl) {
  let currentUrl = initialUrl;
  let cookie = "";
  let referer = "https://www.google.com/";

  for (let redirectCount = 0; redirectCount <= 6; redirectCount++) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "fa-IR,fa;q=0.9,en-US;q=0.7,en;q=0.6",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": referer,
        ...(cookie ? { "Cookie": cookie } : {})
      },
      cf: { cacheEverything: false, cacheTtl: 0 }
    });

    cookie = mergeCookies(cookie, response.headers.get("set-cookie"));

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} without Location`);
      referer = currentUrl;
      currentUrl = safeRedirectUrl(location, currentUrl);
      continue;
    }

    const html = await response.text();
    const javascriptCookies = extractJavaScriptCookies(html);
    if (javascriptCookies.length) {
      cookie = mergeCookiePairs(cookie, javascriptCookies);
    }

    const redirectTarget = extractHtmlRedirect(html);
    if (redirectTarget && /redirecting/i.test(html)) {
      referer = currentUrl;
      currentUrl = safeRedirectUrl(redirectTarget, currentUrl);
      continue;
    }

    // برخی میزبان‌ها به‌جای Redirect واقعی، یک صفحه JavaScript می‌فرستند که
    // Cookie می‌سازد و سپس همان صفحه را reload می‌کند.
    if (javascriptCookies.length && /redirecting|location\.reload|reload\s*\(/i.test(html)) {
      referer = currentUrl;
      continue;
    }

    return { response, html, finalUrl: currentUrl, redirectCount };
  }

  throw new Error("Too many redirects from source website");
}

function extractHtmlRedirect(html) {
  const patterns = [
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url\s*=\s*([^"'>\s;]+)[^"']*["']/i,
    /(?:window\.)?location\.replace\(\s*["'`]([^"'`]+)["'`]\s*\)/i,
    /(?:window\.)?location\.href\s*=\s*["'`]([^"'`]+)["'`]/i,
    /(?:window\.)?location\s*=\s*["'`]([^"'`]+)["'`]/i,
    /<a[^>]+href=["']([^"']+)["'][^>]*>\s*(?:Redirecting|Continue)/i
  ];
  for (const pattern of patterns) {
    const match = String(html).match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return null;
}

function extractJavaScriptCookies(html) {
  const result = [];
  const source = String(html);
  const variables = new Map();

  // متغیرهای رشته‌ای ساده‌ای که صفحه Challenge قبل از setCookie می‌سازد.
  const variablePattern = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']*)["']\s*;/g;
  let variableMatch;
  while ((variableMatch = variablePattern.exec(source)) !== null) {
    variables.set(variableMatch[1], decodeJsString(variableMatch[2]));
  }

  // فراخوانی تابعی مانند: setCookie("name", "value", 123456)
  const setCookiePattern = /setCookie\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*,/gi;
  let match;
  while ((match = setCookiePattern.exec(source)) !== null) {
    result.push([decodeJsString(match[1]), decodeJsString(match[2])]);
  }

  // حالت متغیری: setCookie(cookieName, cookieValue, expires)
  const variableCallPattern = /setCookie\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*,/gi;
  while ((match = variableCallPattern.exec(source)) !== null) {
    const name = variables.get(match[1]);
    const value = variables.get(match[2]);
    if (name !== undefined && value !== undefined) result.push([name, value]);
  }

  // حالت ترکیبی: یکی از آرگومان‌ها literal و دیگری variable است.
  const mixedCallPattern = /setCookie\(\s*(["'][^"']*["']|[A-Za-z_$][\w$]*)\s*,\s*(["'][^"']*["']|[A-Za-z_$][\w$]*)\s*,/gi;
  while ((match = mixedCallPattern.exec(source)) !== null) {
    const name = resolveSimpleJsToken(match[1], variables);
    const value = resolveSimpleJsToken(match[2], variables);
    if (name !== undefined && value !== undefined) result.push([name, value]);
  }

  // حالت مستقیم: document.cookie = "name=value; path=/"
  const directPattern = /document\.cookie\s*=\s*["']([^"']+)["']/gi;
  while ((match = directPattern.exec(source)) !== null) {
    const pair = decodeJsString(match[1]).split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) result.push([pair.slice(0, index).trim(), pair.slice(index + 1).trim()]);
  }

  const unique = new Map();
  for (const [name, value] of result) {
    if (name && name !== "cname") unique.set(name, value);
  }
  return [...unique.entries()];
}

function resolveSimpleJsToken(token, variables) {
  const value = String(token).trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return decodeJsString(value.slice(1, -1));
  }
  return variables.get(value);
}

function decodeJsString(value) {
  return String(value)
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([\\"'])/g, "$1");
}

function mergeCookiePairs(existing, pairs) {
  const jar = new Map();
  for (const pair of String(existing || "").split(/;\s*/).filter(Boolean)) {
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  for (const [name, value] of pairs) jar.set(name, value);
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function safeRedirectUrl(target, base) {
  const next = new URL(target, base);
  const allowed = new URL(SOURCE_URL).hostname;
  if (next.hostname !== allowed && next.hostname !== `www.${allowed}`) {
    throw new Error(`Blocked external redirect to ${next.hostname}`);
  }
  return next.toString();
}

function mergeCookies(existing, setCookie) {
  const jar = new Map();
  for (const pair of String(existing || "").split(/;\s*/).filter(Boolean)) {
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  if (setCookie) {
    const cookies = String(setCookie).split(/,(?=\s*[^;,=]+=[^;,]+)/);
    for (const item of cookies) {
      const pair = item.split(";", 1)[0].trim();
      const index = pair.indexOf("=");
      if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function htmlToText(html) {
  return decodeHtml(String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|article|section|header|footer|main|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
}

function decodeHtml(value) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    zwnj: "\u200c", ndash: "–", mdash: "—", hellip: "…"
  };
  return value
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
}

function parseOutages(rawText) {
  const text = normalize(rawText)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n");

  const entries = [];
  // به جای وابستگی به ترتیب دکمه‌های «ذخیره» و وضعیت، هر رکورد را با
  // سه نشانه پایدار پیدا می‌کنیم: شروع، پایان و شهر/تاریخ.
  const pattern = /شروع\s*([۰-۹0-9]{1,2})\s*[:：]\s*([۰-۹0-9]{2})[\s\S]{0,80}?پایان\s*(?:تقریبی)?\s*([۰-۹0-9]{1,2})\s*[:：]\s*([۰-۹0-9]{2})[\s\S]{0,1600}?📍\s*([^\n]{1,100}?)\s*([۰-۹0-9]{4}\s*\/\s*[۰-۹0-9]{1,2}\s*\/\s*[۰-۹0-9]{1,2})/g;

  let match;
  let previousEnd = 0;
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(Math.max(previousEnd, match.index - 2500), match.index);
    const dayMatch = before.match(/(?:📅\s*)?(امروز|فردا)\s*([\s\S]*)$/);
    const day = cleanField(dayMatch?.[1] || "");
    let address = cleanField(dayMatch?.[2] || before);
    address = address
      .replace(/^.*?(?:برنامه[ \u200c]?ریزی شده|در حال خاموشی|پایان یافته)/, "")
      .replace(/^.*?ذخیره/, "")
      .replace(/[🟡📅]/g, "")
      .trim();

    const city = cleanField(match[5]);
    if (!address || address.length > 2000 || !city || city.length > 80) continue;

    entries.push({
      status: detectStatus(before),
      day,
      address,
      startTime: toPersianDigits(`${match[1]}:${match[2]}`),
      endTime: toPersianDigits(`${match[3]}:${match[4]}`),
      city,
      date: toPersianDigits(match[6].replace(/\s+/g, ""))
    });
    previousEnd = pattern.lastIndex;
  }

  return deduplicate(entries);
}

function detectStatus(text) {
  if (/در حال خاموشی/.test(text)) return "در حال خاموشی";
  if (/پایان یافته/.test(text)) return "پایان یافته";
  return "برنامه‌ریزی شده";
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return String(text).split(needle).length - 1;
}

function sampleAround(text, needle, length = 450) {
  const index = String(text).indexOf(needle);
  if (index < 0) return String(text).slice(0, length).replace(/\s+/g, " ").trim();
  return String(text)
    .slice(Math.max(0, index - 160), index + length)
    .replace(/\s+/g, " ")
    .trim();
}

function filterOutages(outages, query) {
  const needle = searchKey(query);
  if (!needle) return outages;
  return outages.filter(item =>
    searchKey(`${item.city} ${item.address} ${item.date} ${item.day}`).includes(needle)
  );
}

async function sendSearchResponse(env, chatId, results, title, query) {
  if (!results.length) {
    await sendMessage(env, chatId, `🔍 برای «${escapeHtml(query)}» موردی پیدا نشد.`, MAIN_KEYBOARD);
  } else {
    await sendResults(env, chatId, results.slice(0, 15), title);
  }
}

async function sendResults(env, chatId, results, title) {
  const chunks = [];
  let current = `⚡ <b>${escapeHtml(title)}</b>\n`;

  for (const item of results) {
    const block =
      `\n📍 <b>${escapeHtml(item.city)}</b> — ${escapeHtml(item.day || item.date)}\n` +
      `🕐 ${escapeHtml(item.startTime)} تا ${escapeHtml(item.endTime)}\n` +
      `🗺 ${escapeHtml(item.address)}\n`;

    if ((current + block).length > 3800) {
      chunks.push(current);
      current = block.trimStart();
    } else {
      current += block;
    }
  }

  if (current.trim()) chunks.push(current);
  for (let i = 0; i < chunks.length; i++) {
    await sendMessage(env, chatId, chunks[i], i === chunks.length - 1 ? MAIN_KEYBOARD : undefined);
  }
}

async function sendMessage(env, chatId, text, replyMarkup) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  return telegram(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text
  });
}

async function telegram(env, method, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE}${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method}: ${JSON.stringify(result)}`);
  }
  return result;
}

function searchKey(value = "") {
  return normalize(value)
    .replace(/[\u200c\u200f]/g, " ")
    .replace(/[،,:؛()\-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sameCity(first, second) {
  const a = searchKey(first);
  const b = searchKey(second);
  return a === b || a.includes(b) || b.includes(a);
}

function persianDateInTehran(addDays = 0) {
  const date = new Date(Date.now() + addDays * 86400000);
  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}/${values.month}/${values.day}`;
}

function normalizeDigits(value = "") {
  return String(value)
    .replace(/[۰-۹]/g, digit => "۰۱۲۳۴۵۶۷۸۹".indexOf(digit))
    .replace(/[٠-٩]/g, digit => "٠١٢٣٤٥٦٧٨٩".indexOf(digit));
}

function normalize(value = "") {
  return String(value)
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/ۀ/g, "ه")
    .replace(/\u00a0/g, " ");
}

function cleanField(value = "") {
  return normalize(value).replace(/\s+/g, " ").trim();
}

function deduplicate(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.city}|${item.date}|${item.startTime}|${item.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toPersianDigits(value) {
  return String(value).replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
