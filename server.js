const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');

const app = express();
const PORT = process.env.PORT || 3000;
const sql = neon(process.env.DATABASE_URL);

// Stripe — lazy init to avoid crash if key missing
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Helpers ─────────────────────────────────────────────────
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function timeSince(date) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function navHtml(backHref, backLabel) {
  return '<nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">'
    + '<a href="' + (backHref || '/') + '" class="font-bold text-gray-900">' + esc(backLabel || '\u2190 Syncline') + '</a>'
    + '<a href="/standup" class="bg-pink-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pink-600">Post Standup</a>'
    + '</nav>';
}

function pageWrap(title, bodyContent) {
  return '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<title>' + esc(title) + '</title>'
    + '<script src="https://cdn.tailwindcss.com"></script>'
    + '</head><body class="bg-gray-50 min-h-screen">'
    + bodyContent
    + '</body></html>';
}

// ── DB Init ─────────────────────────────────────────────────
async function initDB() {
  await sql`CREATE TABLE IF NOT EXISTS standups (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    did_yesterday TEXT DEFAULT '',
    doing_today TEXT DEFAULT '',
    blockers TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS analytics_events (
    id SERIAL PRIMARY KEY,
    event_name TEXT NOT NULL,
    session_id TEXT,
    user_email TEXT,
    page TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE INDEX IF NOT EXISTS idx_ae_event ON analytics_events(event_name)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ae_time ON analytics_events(created_at DESC)`;
  console.log('DB initialized');
}

// ── Analytics helper ─────────────────────────────────────────
async function track(eventName, opts) {
  try {
    opts = opts || {};
    await sql`INSERT INTO analytics_events (event_name, session_id, user_email, page, metadata)
      VALUES (${eventName}, ${opts.sessionId || null}, ${opts.userEmail || null}, ${opts.page || null}, ${JSON.stringify(opts.meta || {})})`;
  } catch (e) {
    console.error('track error:', e.message);
  }
}

// ── Health ───────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── POST /api/track ──────────────────────────────────────────
app.post('/api/track', async (req, res) => {
  const allowed = ['page_view', 'checkout_started', 'standup_submitted'];
  const { event, page, sessionId } = req.body;
  if (!event || !allowed.includes(event)) {
    return res.status(400).json({ success: false, error: 'Invalid event' });
  }
  await track(event, { page: page || null, sessionId: sessionId || null });
  res.json({ success: true });
});

// ── GET / ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const body = '<nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">'
    + '<div class="flex items-center gap-2">'
    + '<span class="text-xl font-bold text-gray-900">Syncline</span>'
    + '<span class="text-xs bg-pink-100 text-pink-600 px-2 py-0.5 rounded-full font-medium">Beta</span>'
    + '</div>'
    + '<div class="flex items-center gap-4">'
    + '<a href="/dashboard" class="text-sm text-gray-600 hover:text-gray-900">Dashboard</a>'
    + '<a href="/standup" class="bg-pink-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pink-600 transition-colors">Post Standup</a>'
    + '</div></nav>'
    + '<div class="max-w-2xl mx-auto px-6 py-16 text-center">'
    + '<h1 class="text-4xl font-bold text-gray-900 mb-4">Align your team<br/>without the meeting.</h1>'
    + '<p class="text-lg text-gray-500 mb-8">Syncline lets remote engineering teams run async standups, surface blockers, and stay aligned \u2014 no calendar invite required.</p>'
    + '<div class="flex flex-col sm:flex-row gap-3 justify-center mb-16">'
    + '<a href="/standup" class="bg-pink-500 text-white px-8 py-3 rounded-lg font-semibold hover:bg-pink-600 transition-colors">Post Your Standup</a>'
    + '<a href="/dashboard" class="bg-white text-gray-700 px-8 py-3 rounded-lg font-semibold border border-gray-200 hover:bg-gray-50 transition-colors">View Team Feed</a>'
    + '</div>'
    + '<div class="grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">'
    + '<div class="bg-white rounded-xl p-6 border border-gray-100"><div class="text-2xl mb-3">\ud83d\udccb</div><h3 class="font-semibold text-gray-900 mb-1">Async Standups</h3><p class="text-sm text-gray-500">Post what you did, what you&#x27;re doing, and any blockers \u2014 on your own schedule.</p></div>'
    + '<div class="bg-white rounded-xl p-6 border border-gray-100"><div class="text-2xl mb-3">\ud83d\udea7</div><h3 class="font-semibold text-gray-900 mb-1">Blocker Tracking</h3><p class="text-sm text-gray-500">Surface blockers so your team can help without waiting for the next sync.</p></div>'
    + '<div class="bg-white rounded-xl p-6 border border-gray-100"><div class="text-2xl mb-3">\ud83d\udd17</div><h3 class="font-semibold text-gray-900 mb-1">Team Alignment</h3><p class="text-sm text-gray-500">Everyone stays in the loop. No meetings. No Slack interruptions.</p></div>'
    + '</div>'
    + '<div class="mt-16 bg-pink-50 border border-pink-100 rounded-2xl p-8">'
    + '<h2 class="text-2xl font-bold text-gray-900 mb-2">Get full access \u2014 $1</h2>'
    + '<p class="text-gray-500 mb-6">One-time payment. No subscription. No catch.</p>'
    + '<button id="checkoutBtn" data-checkout="true" class="bg-pink-500 text-white px-8 py-3 rounded-lg font-semibold hover:bg-pink-600 transition-colors text-lg">Unlock Syncline \u2014 $1</button>'
    + '</div>'
    + '</div>'
    + '<script>'
    + '(function(){'
    + 'var sid=sessionStorage.getItem("_sid")||(Math.random().toString(36).slice(2));'
    + 'sessionStorage.setItem("_sid",sid);'
    + 'fetch("/api/track",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:"page_view",page:"/",sessionId:sid})}).catch(function(){});'
    + 'var btn=document.getElementById("checkoutBtn");'
    + 'if(btn){btn.addEventListener("click",function(){fetch("/api/track",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:"checkout_started",page:"/",sessionId:sid})}).catch(function(){});},true);}'
    + '})();'
    + '</script>';
  res.send(pageWrap('Syncline \u2014 Async Standup Tool', body));
});

// ── GET /standup ─────────────────────────────────────────────
app.get('/standup', (req, res) => {
  const body = '<nav class="bg-white border-b border-gray-100 px-6 py-4"><a href="/" class="font-bold text-gray-900">\u2190 Syncline</a></nav>'
    + '<div class="max-w-xl mx-auto px-6 py-10">'
    + '<h1 class="text-2xl font-bold text-gray-900 mb-2">Post your standup</h1>'
    + '<p class="text-gray-500 mb-8">Takes 2 minutes. Your team will see it instantly.</p>'
    + '<form id="sf" class="space-y-5">'
    + '<div><label class="block text-sm font-medium text-gray-700 mb-1">Your email</label>'
    + '<input type="email" name="email" required placeholder="you@company.com" class="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-400"></div>'
    + '<div><label class="block text-sm font-medium text-gray-700 mb-1">What did you do yesterday?</label>'
    + '<textarea name="did_yesterday" rows="3" placeholder="Shipped the auth refactor..." class="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-400"></textarea></div>'
    + '<div><label class="block text-sm font-medium text-gray-700 mb-1">What are you doing today?</label>'
    + '<textarea name="doing_today" rows="3" placeholder="Working on the billing integration..." class="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-400"></textarea></div>'
    + '<div><label class="block text-sm font-medium text-gray-700 mb-1">Any blockers? <span class="text-gray-400 font-normal">(optional)</span></label>'
    + '<textarea name="blockers" rows="2" placeholder="Waiting on API credentials..." class="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-400"></textarea></div>'
    + '<button type="submit" class="w-full bg-pink-500 text-white py-3 rounded-lg font-semibold hover:bg-pink-600 transition-colors">Post Standup</button>'
    + '</form>'
    + '<div id="ok" class="hidden mt-6 bg-green-50 border border-green-200 rounded-lg p-4 text-green-700 text-center">\u2705 Standup posted! <a href="/dashboard" class="underline">View team feed \u2192</a></div>'
    + '<div id="err" class="hidden mt-6 bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-center"></div>'
    + '</div>'
    + '<script>(function(){'
    + 'var sid=sessionStorage.getItem("_sid")||(Math.random().toString(36).slice(2));sessionStorage.setItem("_sid",sid);'
    + 'fetch("/api/track",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:"page_view",page:"/standup",sessionId:sid})}).catch(function(){});'
    + 'document.getElementById("sf").addEventListener("submit",function(e){'
    + 'e.preventDefault();'
    + 'var d={};new FormData(e.target).forEach(function(v,k){d[k]=v;});'
    + 'fetch("/api/standup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)}).then(function(r){return r.json();}).then(function(j){'
    + 'if(j.success){e.target.classList.add("hidden");document.getElementById("ok").classList.remove("hidden");}'
    + 'else{var el=document.getElementById("err");el.textContent=j.error||"Something went wrong";el.classList.remove("hidden");}'
    + '}).catch(function(){document.getElementById("err").textContent="Network error. Please try again.";document.getElementById("err").classList.remove("hidden");});'
    + '});'
    + '})();</script>';
  res.send(pageWrap('Post Standup \u2014 Syncline', body));
});

// ── POST /api/standup ────────────────────────────────────────
app.post('/api/standup', async (req, res) => {
  const { email, did_yesterday, doing_today, blockers } = req.body;
  if (!email) return res.status(400).json({ success: false, error: 'Email is required' });
  try {
    const rows = await sql`INSERT INTO standups (email, did_yesterday, doing_today, blockers)
      VALUES (${email}, ${did_yesterday || ''}, ${doing_today || ''}, ${blockers || ''})
      RETURNING id, email, created_at`;
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('Standup error:', err);
    res.status(500).json({ success: false, error: 'Failed to save standup' });
  }
});

// ── POST /api/checkout ───────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ success: false, error: 'Payments not configured' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Syncline \u2014 Full Access', description: 'One-time payment. Async standups for your remote team.' }, unit_amount: 100 }, quantity: 1 }],
      mode: 'payment',
      success_url: req.protocol + '://' + req.get('host') + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: req.protocol + '://' + req.get('host') + '/cancel',
      customer_email: req.body.email || undefined
    });
    await track('checkout_started', { sessionId: req.body.sessionId || null, userEmail: req.body.email || null, page: '/api/checkout', meta: { stripe_session_id: session.id } });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ success: false, error: 'Checkout failed' });
  }
});

// ── GET /success ─────────────────────────────────────────────
app.get('/success', async (req, res) => {
  const { session_id } = req.query;
  var userEmail = null;
  if (session_id && stripe) {
    try {
      var session = await stripe.checkout.sessions.retrieve(session_id);
      userEmail = session.customer_email || null;
    } catch (e) { console.error('Session verify:', e.message); }
  }
  await track('payment_success', { userEmail: userEmail, page: '/success', meta: { session_id: session_id || null } });
  const body = '<div class="min-h-screen flex items-center justify-center">'
    + '<div class="text-center p-8 max-w-md">'
    + '<div class="text-6xl mb-6">\u2705</div>'
    + '<h1 class="text-3xl font-bold text-gray-900 mb-3">You&#x27;re in!</h1>'
    + '<p class="text-gray-500 mb-2">Payment confirmed.</p>'
    + '<p class="text-gray-500 mb-8">Welcome to Syncline \u2014 let&#x27;s get your team aligned.</p>'
    + '<div class="flex flex-col sm:flex-row gap-3 justify-center">'
    + '<a href="/standup" class="bg-pink-500 text-white px-6 py-3 rounded-lg font-semibold hover:bg-pink-600">Post Your First Standup</a>'
    + '<a href="/dashboard" class="bg-white text-gray-700 px-6 py-3 rounded-lg font-semibold border border-gray-200 hover:bg-gray-50">View Team Feed</a>'
    + '</div></div></div>';
  res.send(pageWrap('Payment Successful \u2014 Syncline', body));
});

// ── GET /cancel ───────────────────────────────────────────────
app.get('/cancel', async (req, res) => {
  await track('payment_cancelled', { page: '/cancel', meta: {} });
  const body = '<div class="min-h-screen flex items-center justify-center">'
    + '<div class="text-center p-8 max-w-md">'
    + '<div class="text-6xl mb-6">\ud83d\udcb8</div>'
    + '<h1 class="text-3xl font-bold text-gray-900 mb-3">Payment cancelled</h1>'
    + '<p class="text-gray-500 mb-8">No worries \u2014 you haven&#x27;t been charged. Come back when you&#x27;re ready.</p>'
    + '<a href="/" class="bg-pink-500 text-white px-6 py-3 rounded-lg font-semibold hover:bg-pink-600">Back to Syncline</a>'
    + '</div></div>';
  res.send(pageWrap('Payment Cancelled \u2014 Syncline', body));
});

// ── GET /dashboard ───────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
  try {
    const standups = await sql`SELECT id, email, did_yesterday, doing_today, blockers, created_at FROM standups ORDER BY created_at DESC LIMIT 50`;
    var rows = '';
    var blockerCount = 0;
    standups.forEach(function(s) {
      var initial = s.email && s.email.length > 0 ? s.email[0].toUpperCase() : '?';
      var hasBlocker = s.blockers && s.blockers.trim();
      if (hasBlocker) blockerCount++;
      rows += '<div class="bg-white rounded-xl border border-gray-100 p-5">';
      rows += '<div class="flex items-center justify-between mb-3">';
      rows += '<div class="flex items-center gap-2">';
      rows += '<div class="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center text-sm font-semibold text-pink-600">' + esc(initial) + '</div>';
      rows += '<span class="font-medium text-gray-900 text-sm">' + esc(s.email) + '</span>';
      rows += '</div><span class="text-xs text-gray-400">' + timeSince(s.created_at) + '</span></div>';
      if (s.did_yesterday) rows += '<div class="mb-2"><span class="text-xs font-medium text-gray-400 uppercase tracking-wide">Yesterday</span><p class="text-sm text-gray-700 mt-0.5">' + esc(s.did_yesterday) + '</p></div>';
      if (s.doing_today) rows += '<div class="mb-2"><span class="text-xs font-medium text-gray-400 uppercase tracking-wide">Today</span><p class="text-sm text-gray-700 mt-0.5">' + esc(s.doing_today) + '</p></div>';
      if (hasBlocker) rows += '<div class="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><span class="text-xs font-semibold text-amber-600">\ud83d\udea7 Blocker:</span><p class="text-sm text-amber-800 mt-0.5">' + esc(s.blockers) + '</p></div>';
      rows += '</div>';
    });
    if (standups.length === 0) {
      rows = '<div class="text-center py-16 text-gray-400"><div class="text-4xl mb-4">\ud83d\udccb</div><p class="font-medium">No standups yet</p><p class="text-sm mt-1"><a href="/standup" class="text-pink-500 underline">Post the first one \u2192</a></p></div>';
    }
    var countLabel = standups.length + ' update' + (standups.length !== 1 ? 's' : '');
    var blockerLabel = blockerCount > 0 ? '<span class="text-amber-600 font-medium">\ud83d\udea7 ' + blockerCount + ' blocker' + (blockerCount !== 1 ? 's' : '') + '</span>' : '';
    const body = '<nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">'
      + '<a href="/" class="font-bold text-gray-900">\u2190 Syncline</a>'
      + '<a href="/standup" class="bg-pink-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pink-600">Post Standup</a>'
      + '</nav>'
      + '<div class="max-w-2xl mx-auto px-6 py-8">'
      + '<div class="flex items-center justify-between mb-6">'
      + '<h1 class="text-2xl font-bold text-gray-900">Team Feed</h1>'
      + '<div class="flex gap-4 text-sm text-gray-500"><span>' + countLabel + '</span>' + blockerLabel + '</div>'
      + '</div>'
      + '<div class="space-y-4">' + rows + '</div>'
      + '</div>';
    res.send(pageWrap('Team Feed \u2014 Syncline', body));
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard');
  }
});

// ── GET /analytics ───────────────────────────────────────────
app.get('/analytics', async (req, res) => {
  try {
    const cRows = await sql`SELECT
      COUNT(*) FILTER (WHERE event_name = 'page_view' AND page = '/') AS hv,
      COUNT(*) FILTER (WHERE event_name = 'checkout_started') AS cs,
      COUNT(*) FILTER (WHERE event_name = 'payment_success') AS ps,
      COUNT(*) FILTER (WHERE event_name = 'payment_cancelled') AS pc
      FROM analytics_events WHERE created_at > NOW() - INTERVAL '30 days'`;
    const c = cRows[0] || {};
    var hv = parseInt(c.hv) || 0;
    var cs = parseInt(c.cs) || 0;
    var ps = parseInt(c.ps) || 0;
    var pc = parseInt(c.pc) || 0;
    var convRate = cs > 0 ? Math.round(ps / cs * 100) : 0;
    var abandRate = cs > 0 ? Math.round(pc / cs * 100) : 0;

    const recent = await sql`SELECT event_name, user_email, page, created_at FROM analytics_events ORDER BY created_at DESC LIMIT 20`;

    var metricCards = '';
    var metrics = [
      ['Homepage Views', hv, 'Last 30 days', 'text-gray-900'],
      ['Checkout Started', cs, 'Clicked pay button', 'text-blue-600'],
      ['Payments Completed', ps, 'Confirmed payment', 'text-green-600'],
      ['Payments Cancelled', pc, 'Abandoned checkout', 'text-red-500'],
      ['Conversion Rate', convRate + '%', cs > 0 ? 'started \u2192 paid' : 'No data yet', convRate > 20 ? 'text-green-600' : 'text-gray-700'],
      ['Abandonment Rate', abandRate + '%', cs > 0 ? 'started \u2192 cancelled' : 'No data yet', abandRate > 50 ? 'text-red-500' : 'text-gray-700']
    ];
    metrics.forEach(function(m) {
      metricCards += '<div class="bg-white rounded-xl border border-gray-100 p-5">'
        + '<p class="text-sm text-gray-500 mb-1">' + esc(m[0]) + '</p>'
        + '<p class="text-3xl font-bold ' + m[3] + '">' + esc(String(m[1])) + '</p>'
        + '<p class="text-xs text-gray-400 mt-1">' + esc(m[2]) + '</p>'
        + '</div>';
    });

    var funnelBars = '';
    var funnelSteps = [
      ['Homepage Views', hv, hv, 'bg-gray-400', 'text-gray-900'],
      ['Checkout Started', cs, hv, 'bg-blue-400', 'text-blue-600'],
      ['Payment Completed', ps, hv, 'bg-green-400', 'text-green-600'],
      ['Payment Cancelled', pc, hv, 'bg-red-300', 'text-red-500']
    ];
    funnelSteps.forEach(function(f) {
      var pct = f[2] > 0 ? Math.min(100, Math.round(f[1] / f[2] * 100)) : 0;
      funnelBars += '<div>'
        + '<div class="flex justify-between text-sm mb-1"><span class="text-gray-600">' + esc(f[0]) + '</span><span class="font-medium ' + f[4] + '">' + f[1] + '</span></div>'
        + '<div class="w-full bg-gray-100 rounded-full h-2"><div class="' + f[3] + ' h-2 rounded-full" style="width:' + pct + '%"></div></div>'
        + '</div>';
    });

    var badgeMap = { page_view: 'bg-gray-100 text-gray-600', checkout_started: 'bg-blue-100 text-blue-700', payment_success: 'bg-green-100 text-green-700', payment_cancelled: 'bg-red-100 text-red-600', standup_submitted: 'bg-purple-100 text-purple-700' };
    var recentRows = '';
    recent.forEach(function(e) {
      var badge = badgeMap[e.event_name] || 'bg-gray-100 text-gray-600';
      var t = new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      recentRows += '<tr class="border-b border-gray-50">'
        + '<td class="py-2 px-4"><span class="text-xs px-2 py-0.5 rounded-full font-medium ' + badge + '">' + esc(e.event_name) + '</span></td>'
        + '<td class="py-2 px-4 text-xs text-gray-500">' + esc(e.user_email || '\u2014') + '</td>'
        + '<td class="py-2 px-4 text-xs text-gray-400">' + esc(e.page || '\u2014') + '</td>'
        + '<td class="py-2 px-4 text-xs text-gray-400">' + t + '</td>'
        + '</tr>';
    });
    if (!recentRows) recentRows = '<tr><td colspan="4" class="py-8 text-center text-sm text-gray-400">No events yet</td></tr>';

    const body = '<nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">'
      + '<a href="/" class="font-bold text-gray-900">\u2190 Syncline</a>'
      + '<span class="text-sm text-gray-500">Analytics Dashboard</span>'
      + '</nav>'
      + '<div class="max-w-4xl mx-auto px-6 py-8">'
      + '<div class="mb-8"><h1 class="text-2xl font-bold text-gray-900 mb-1">Checkout Analytics</h1>'
      + '<p class="text-sm text-gray-500">Last 30 days \u00b7 Checkout abandonment &amp; payment conversion</p></div>'
      + '<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">' + metricCards + '</div>'
      + '<div class="bg-white rounded-xl border border-gray-100 p-6 mb-6">'
      + '<h2 class="font-semibold text-gray-900 mb-4">Checkout Funnel</h2>'
      + '<div class="space-y-3">' + funnelBars + '</div>'
      + '</div>'
      + '<div class="bg-white rounded-xl border border-gray-100 overflow-hidden">'
      + '<div class="px-6 py-4 border-b border-gray-50"><h2 class="font-semibold text-gray-900">Recent Events</h2></div>'
      + '<table class="w-full">'
      + '<thead class="bg-gray-50"><tr>'
      + '<th class="py-2 px-4 text-left text-xs font-medium text-gray-500">Event</th>'
      + '<th class="py-2 px-4 text-left text-xs font-medium text-gray-500">Email</th>'
      + '<th class="py-2 px-4 text-left text-xs font-medium text-gray-500">Page</th>'
      + '<th class="py-2 px-4 text-left text-xs font-medium text-gray-500">Time</th>'
      + '</tr></thead>'
      + '<tbody>' + recentRows + '</tbody>'
      + '</table></div></div>';
    res.send(pageWrap('Analytics \u2014 Syncline', body));
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).send('Error loading analytics');
  }
});

// ── Error Handling ───────────────────────────────────────────
app.use(function(err, req, res, next) {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────
initDB()
  .then(function() { app.listen(PORT, function() { console.log('Syncline running on port ' + PORT); }); })
  .catch(function(err) {
    console.error('DB init failed:', err);
    app.listen(PORT, function() { console.log('Syncline running on port ' + PORT + ' (DB init failed)'); });
  });

process.on('SIGTERM', function() { process.exit(0); });
