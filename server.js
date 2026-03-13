const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
const sql = neon(process.env.DATABASE_URL);

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Database Init ──────────────────────────────────────────
async function initDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS standups (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      did_yesterday TEXT,
      doing_today TEXT,
      blockers TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id SERIAL PRIMARY KEY,
      event_name TEXT NOT NULL,
      session_id TEXT,
      user_email TEXT,
      page TEXT,
      referrer TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_analytics_event_name ON analytics_events(event_name)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_analytics_created_at ON analytics_events(created_at DESC)`;
  console.log('Database initialized');
}

// ── Analytics helper ──────────────────────────────────────
async function trackEvent(eventName, opts = {}) {
  try {
    await sql`
      INSERT INTO analytics_events (event_name, session_id, user_email, page, referrer, metadata)
      VALUES (
        ${eventName},
        ${opts.sessionId || null},
        ${opts.userEmail || null},
        ${opts.page || null},
        ${opts.referrer || null},
        ${JSON.stringify(opts.metadata || {})}
      )
    `;
  } catch (err) {
    console.error('Analytics track error:', err.message);
  }
}

// ── Health ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Homepage ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Syncline — Async Standup Tool</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
    <div class="flex items-center gap-2">
      <span class="text-xl font-bold text-gray-900">Syncline</span>
      <span class="text-xs bg-pink-100 text-pink-600 px-2 py-0.5 rounded-full font-medium">Beta</span>
    </div>
    <div class="flex items-center gap-4">
      <a href="/dashboard" class="text-sm text-gray-600 hover:text-gray-900">Dashboard</a>
      <a href="/standup" class="bg-pink-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pink-600 transition-colors">Post Standup</a>
    </div>
  </nav>

  <div class="max-w-2xl mx-auto px-6 py-16 text-center">
    <h1 class="text-4xl font-bold text-gray-900 mb-4">Align your team<br/>without the meeting.</h1>
    <p class="text-lg text-gray-500 mb-8">Syncline lets remote engineering teams run async standups, surface blockers, and stay aligned — no calendar invite required.</p>

    <div class="flex flex-col sm:flex-row gap-3 justify-center mb-16">
      <a href="/standup" class="bg-pink-500 text-white px-8 py-3 rounded-lg font-semibold hover:bg-pink-600 transition-colors">Post Your Standup</a>
      <a href="/dashboard" class="bg-white text-gray-700 px-8 py-3 rounded-lg font-semibold border border-gray-200 hover:bg-gray-50 transition-colors">View Team Feed</a>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">
      <div class="bg-white rounded-xl p-6 border border-gray-100">
        <div class="text-2xl mb-3">📋</div>
        <h3 class="font-semibold text-gray-900 mb-1">Async Standups</h3>
        <p class="text-sm text-gray-500">Post what you did, what you're doing, and any blockers — on your own schedule.</p>
      </div>
      <div class="bg-white rounded-xl p-6 border border-gray-100">
        <div class="text-2xl mb-3">🚧</div>
        <h3 class="font-semibold text-gray-900 mb-1">Blocker Tracking</h3>
        <p class="text-sm text-gray-500">Surface blockers so your team can help without waiting for the next sync.</p>
      </div>
      <div class="bg-white rounded-xl p-6 border border-gray-100">
        <div class="text-2xl mb-3">🔗</div>
        <h3 class="font-semibold text-gray-900 mb-1">Team Alignment</h3>
        <p class="text-sm text-gray-500">Everyone stays in the loop. No meetings. No Slack interruptions.</p>
      </div>
    </div>

    <div class="mt-16 bg-pink-50 border border-pink-100 rounded-2xl p-8">
      <h2 class="text-2xl font-bold text-gray-900 mb-2">Get full access — $1</h2>
      <p class="text-gray-500 mb-6">One-time payment. No subscription. No catch.</p>
      <button id="checkoutBtn" data-checkout="true" class="bg-pink-500 text-white px-8 py-3 rounded-lg font-semibold hover:bg-pink-600 transition-colors text-lg">
        Unlock Syncline — $1
      </button>
    </div>
  </div>

  <script>
    // Track page view
    const sid = sessionStorage.getItem('_sid') || Math.random().toString(36).slice(2);
    sessionStorage.setItem('_sid', sid);
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'page_view', page: '/', sessionId: sid })
    }).catch(() => {});

    // Track checkout intent before platform handler fires
    document.getElementById('checkoutBtn').addEventListener('click', function() {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'checkout_started', page: '/', sessionId: sid })
      }).catch(() => {});
    }, true); // capture phase so it runs before the platform handler
  </script>
</body>
</html>`);
});

// ── Standup Form ────────────────────────────────────────────
app.get('/standup', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Post Standup — Syncline</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <nav class="bg-white border-b border-gray-100 px-6 py-4">
    <a href="/" class="font-bold text-gray-900">← Syncline</a>
  </nav>
  <div class="max-w-xl mx-auto px-6 py-10">
    <h1 class="text-2xl font-bold text-gray-900 mb-2">Post your standup</h1>
    <p class="text-gray-500 mb-8">Takes 2 minutes. Your team will see it instantly.</p>

    <form id="standupForm" class="space-y-5">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Your email</label>
        <input type="email" name="email" required placeholder="you@company.com"
          class="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-400" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">What did you do yesterday?</label>
        <textarea name="did_yesterday" rows="3" placeholder="Shipped the auth refactor, reviewed 2 PRs..."
          class="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-400"></textarea>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">What are you doing today?</label>
        <textarea name="doing_today" rows="3" placeholder="Working on the billing integration..."
          class="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-400"></textarea>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Any blockers? <span class="text-gray-400 font-normal">(optional)</span></label>
        <textarea name="blockers" rows="2" placeholder="Waiting on API credentials from infra team..."
          class="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-400"></textarea>
      </div>
      <button type="submit" class="w-full bg-pink-500 text-white py-3 rounded-lg font-semibold hover:bg-pink-600 transition-colors">
        Post Standup
      </button>
    </form>
    <div id="successMsg" class="hidden mt-6 bg-green-50 border border-green-200 rounded-lg p-4 text-green-700 text-center">
      ✅ Standup posted! <a href="/dashboard" class="underline">View team feed →</a>
    </div>
    <div id="errorMsg" class="hidden mt-6 bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-center"></div>
  </div>
  <script>
    const sid = sessionStorage.getItem('_sid') || Math.random().toString(36).slice(2);
    sessionStorage.setItem('_sid', sid);
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'page_view', page: '/standup', sessionId: sid })
    }).catch(() => {});

    document.getElementById('standupForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form));
      try {
        const res = await fetch('/api/standup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const json = await res.json();
        if (json.success) {
          form.classList.add('hidden');
          document.getElementById('successMsg').classList.remove('hidden');
        } else {
          document.getElementById('errorMsg').textContent = json.error || 'Something went wrong';
          document.getElementById('errorMsg').classList.remove('hidden');
        }
      } catch (err) {
        document.getElementById('errorMsg').textContent = 'Network error. Please try again.';
        document.getElementById('errorMsg').classList.remove('hidden');
      }
    });
  </script>
</body>
</html>`);
});

// ── API: Submit standup ─────────────────────────────────────
app.post('/api/standup', async (req, res) => {
  const { email, did_yesterday, doing_today, blockers } = req.body;
  if (!email) return res.status(400).json({ success: false, error: 'Email is required' });
  try {
    const [standup] = await sql`
      INSERT INTO standups (email, did_yesterday, doing_today, blockers)
      VALUES (${email}, ${did_yesterday || ''}, ${doing_today || ''}, ${blockers || ''})
      RETURNING id, email, created_at
    `;
    res.json({ success: true, data: standup });
  } catch (err) {
    console.error('Standup error:', err);
    res.status(500).json({ success: false, error: 'Failed to save standup' });
  }
});

// ── API: Track analytics event ─────────────────────────────
app.post('/api/track', async (req, res) => {
  const { event, page, sessionId, userEmail, metadata } = req.body;
  if (!event) return res.status(400).json({ success: false, error: 'event is required' });
  // Only allow safe event names
  const allowed = ['page_view', 'checkout_started', 'standup_submitted'];
  if (!allowed.includes(event)) return res.status(400).json({ success: false, error: 'Unknown event' });
  await trackEvent(event, { page, sessionId, userEmail, metadata });
  res.json({ success: true });
});

// ── Stripe Checkout ─────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Syncline — Full Access',
            description: 'One-time payment. Async standups for your remote team.',
          },
          unit_amount: 100, // $1.00
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/cancel`,
      customer_email: req.body.email || undefined,
    });

    // Track server-side checkout_started
    await trackEvent('checkout_started', {
      sessionId: req.body.sessionId || null,
      userEmail: req.body.email || null,
      page: '/api/checkout',
      metadata: { stripe_session_id: session.id }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ success: false, error: 'Checkout failed' });
  }
});

// ── Success ─────────────────────────────────────────────────
app.get('/success', async (req, res) => {
  const { session_id } = req.query;
  let userEmail = null;

  if (session_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      userEmail = session.customer_email || null;
    } catch (err) {
      console.error('Session verify error:', err.message);
    }
  }

  // Track payment_success server-side
  await trackEvent('payment_success', {
    userEmail,
    page: '/success',
    metadata: { session_id: session_id || null }
  });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Successful — Syncline</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center">
  <div class="text-center p-8 max-w-md">
    <div class="text-6xl mb-6">✅</div>
    <h1 class="text-3xl font-bold text-gray-900 mb-3">You're in!</h1>
    <p class="text-gray-500 mb-2">Payment confirmed.</p>
    <p class="text-gray-500 mb-8">Welcome to Syncline — let's get your team aligned.</p>
    <div class="flex flex-col sm:flex-row gap-3 justify-center">
      <a href="/standup" class="bg-pink-500 text-white px-6 py-3 rounded-lg font-semibold hover:bg-pink-600">Post Your First Standup</a>
      <a href="/dashboard" class="bg-white text-gray-700 px-6 py-3 rounded-lg font-semibold border border-gray-200 hover:bg-gray-50">View Team Feed</a>
    </div>
  </div>
</body>
</html>`);
});

// ── Cancel ──────────────────────────────────────────────────
app.get('/cancel', async (req, res) => {
  // Track payment_cancelled server-side
  await trackEvent('payment_cancelled', {
    page: '/cancel',
    metadata: {}
  });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Cancelled — Syncline</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center">
  <div class="text-center p-8 max-w-md">
    <div class="text-6xl mb-6">💸</div>
    <h1 class="text-3xl font-bold text-gray-900 mb-3">Payment cancelled</h1>
    <p class="text-gray-500 mb-8">No worries — you haven't been charged. Come back when you're ready.</p>
    <a href="/" class="bg-pink-500 text-white px-6 py-3 rounded-lg font-semibold hover:bg-pink-600">Back to Syncline</a>
  </div>
</body>
</html>`);
});

// ── Team Dashboard ──────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
  try {
    const standups = await sql`
      SELECT id, email, did_yesterday, doing_today, blockers, created_at
      FROM standups
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const rows = standups.map(s => {
      const hasBlockers = s.blockers && s.blockers.trim();
      const timeAgo = timeSince(s.created_at);
      return `
        <div class="bg-white rounded-xl border border-gray-100 p-5">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center text-sm font-semibold text-pink-600">${escHtml(s.email[0].toUpperCase())}</div>
              <span class="font-medium text-gray-900 text-sm">${escHtml(s.email)}</span>
            </div>
            <span class="text-xs text-gray-400">${timeAgo}</span>
          </div>
          ${s.did_yesterday ? `<div class="mb-2"><span class="text-xs font-medium text-gray-400 uppercase tracking-wide">Yesterday</span><p class="text-sm text-gray-700 mt-0.5">${escHtml(s.did_yesterday)}</p></div>` : ''}
          ${s.doing_today ? `<div class="mb-2"><span class="text-xs font-medium text-gray-400 uppercase tracking-wide">Today</span><p class="text-sm text-gray-700 mt-0.5">${escHtml(s.doing_today)}</p></div>` : ''}
          ${hasBlockers ? `<div class="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><span class="text-xs font-semibold text-amber-600">🚧 Blocker:</span><p class="text-sm text-amber-800 mt-0.5">${escHtml(s.blockers)}</p></div>` : ''}
        </div>
      `;
    }).join('');

    const blockerCount = standups.filter(s => s.blockers && s.blockers.trim()).length;
    const empty = standups.length === 0 ? `
      <div class="text-center py-16 text-gray-400">
        <div class="text-4xl mb-4">📋</div>
        <p class="font-medium">No standups yet</p>
        <p class="text-sm mt-1"><a href="/standup" class="text-pink-500 underline">Post the first one →</a></p>
      </div>` : '';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Feed — Syncline</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
    <a href="/" class="font-bold text-gray-900">← Syncline</a>
    <a href="/standup" class="bg-pink-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pink-600">Post Standup</a>
  </nav>
  <div class="max-w-2xl mx-auto px-6 py-8">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">Team Feed</h1>
      <div class="flex gap-4 text-sm text-gray-500">
        <span>${standups.length} update${standups.length !== 1 ? 's' : ''}</span>
        ${blockerCount > 0 ? `<span class="text-amber-600 font-medium">🚧 ${blockerCount} blocker${blockerCount !== 1 ? 's' : ''}</span>` : ''}
      </div>
    </div>
    <div class="space-y-4">${rows}${empty}</div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard');
  }
});

// ── Analytics Dashboard ─────────────────────────────────────
app.get('/analytics', async (req, res) => {
  try {
    // Funnel counts (last 30 days)
    const [counts] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE event_name = 'page_view' AND page = '/') AS homepage_views,
        COUNT(*) FILTER (WHERE event_name = 'checkout_started') AS checkout_started,
        COUNT(*) FILTER (WHERE event_name = 'payment_success') AS payment_success,
        COUNT(*) FILTER (WHERE event_name = 'payment_cancelled') AS payment_cancelled,
        COUNT(*) FILTER (WHERE event_name = 'page_view') AS total_page_views,
        COUNT(*) FILTER (WHERE event_name = 'standup_submitted') AS standups_submitted
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '30 days'
    `;

    // Daily checkout_started + payment_success for last 14 days
    const daily = await sql`
      SELECT
        DATE_TRUNC('day', created_at) AS day,
        COUNT(*) FILTER (WHERE event_name = 'checkout_started') AS checkout_started,
        COUNT(*) FILTER (WHERE event_name = 'payment_success') AS payment_success,
        COUNT(*) FILTER (WHERE event_name = 'payment_cancelled') AS payment_cancelled
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY 1
      ORDER BY 1 DESC
    `;

    // Recent events
    const recent = await sql`
      SELECT event_name, user_email, page, created_at
      FROM analytics_events
      ORDER BY created_at DESC
      LIMIT 20
    `;

    const cs = parseInt(counts.checkout_started) || 0;
    const ps = parseInt(counts.payment_success) || 0;
    const pc = parseInt(counts.payment_cancelled) || 0;
    const hv = parseInt(counts.homepage_views) || 0;
    const convRate = cs > 0 ? Math.round((ps / cs) * 100) : 0;
    const abandRate = cs > 0 ? Math.round((pc / cs) * 100) : 0;

    const metricCard = (label, value, sub, color) => `
      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <p class="text-sm text-gray-500 mb-1">${label}</p>
        <p class="text-3xl font-bold ${color}">${value}</p>
        ${sub ? `<p class="text-xs text-gray-400 mt-1">${sub}</p>` : ''}
      </div>`;

    const dailyRows = daily.map(d => {
      const date = new Date(d.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `<tr class="border-b border-gray-50">
        <td class="py-2 px-4 text-sm text-gray-600">${date}</td>
        <td class="py-2 px-4 text-sm text-gray-700 text-center">${d.checkout_started}</td>
        <td class="py-2 px-4 text-sm text-green-600 text-center font-medium">${d.payment_success}</td>
        <td class="py-2 px-4 text-sm text-red-400 text-center">${d.payment_cancelled}</td>
      </tr>`;
    }).join('');

    const recentRows = recent.map(e => {
      const badge = {
        page_view: 'bg-gray-100 text-gray-600',
        checkout_started: 'bg-blue-100 text-blue-700',
        payment_success: 'bg-green-100 text-green-700',
        payment_cancelled: 'bg-red-100 text-red-600',
        standup_submitted: 'bg-purple-100 text-purple-700'
      }[e.event_name] || 'bg-gray-100 text-gray-600';
      const t = new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<tr class="border-b border-gray-50">
        <td class="py-2 px-4"><span class="text-xs px-2 py-0.5 rounded-full font-medium ${badge}">${escHtml(e.event_name)}</span></td>
        <td class="py-2 px-4 text-xs text-gray-500">${escHtml(e.user_email || '—')}</td>
        <td class="py-2 px-4 text-xs text-gray-400">${escHtml(e.page || '—')}</td>
        <td class="py-2 px-4 text-xs text-gray-400">${t}</td>
      </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Analytics — Syncline</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
  <nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
    <a href="/" class="font-bold text-gray-900">← Syncline</a>
    <span class="text-sm text-gray-500">Analytics Dashboard</span>
  </nav>
  <div class="max-w-4xl mx-auto px-6 py-8">
    <div class="mb-8">
      <h1 class="text-2xl font-bold text-gray-900 mb-1">Checkout Analytics</h1>
      <p class="text-sm text-gray-500">Last 30 days · Checkout abandonment &amp; payment conversion</p>
    </div>

    <!-- Funnel Metrics -->
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
      ${metricCard('Homepage Views', hv, 'Last 30 days', 'text-gray-900')}
      ${metricCard('Checkout Started', cs, 'Clicked pay button', 'text-blue-600')}
      ${metricCard('Payments Success', ps, 'Completed payment', 'text-green-600')}
      ${metricCard('Payments Cancelled', pc, 'Abandoned checkout', 'text-red-500')}
      ${metricCard('Conversion Rate', convRate + '%', cs > 0 ? 'started → paid' : 'No data yet', convRate > 20 ? 'text-green-600' : 'text-gray-700')}
      ${metricCard('Abandonment Rate', abandRate + '%', cs > 0 ? 'started → cancelled' : 'No data yet', abandRate > 50 ? 'text-red-500' : 'text-gray-700')}
    </div>

    <!-- Funnel Visualization -->
    <div class="bg-white rounded-xl border border-gray-100 p-6 mb-6">
      <h2 class="font-semibold text-gray-900 mb-4">Checkout Funnel</h2>
      <div class="space-y-3">
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-gray-600">Homepage Views</span>
            <span class="font-medium">${hv}</span>
          </div>
          <div class="w-full bg-gray-100 rounded-full h-2">
            <div class="bg-gray-400 h-2 rounded-full" style="width: 100%"></div>
          </div>
        </div>
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-gray-600">Checkout Started</span>
            <span class="font-medium text-blue-600">${cs} <span class="text-gray-400 font-normal">(${hv > 0 ? Math.round(cs/hv*100) : 0}% of views)</span></span>
          </div>
          <div class="w-full bg-gray-100 rounded-full h-2">
            <div class="bg-blue-400 h-2 rounded-full" style="width: ${hv > 0 ? Math.min(100, Math.round(cs/hv*100)) : 0}%"></div>
          </div>
        </div>
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-gray-600">Payment Success</span>
            <span class="font-medium text-green-600">${ps} <span class="text-gray-400 font-normal">(${convRate}% conversion)</span></span>
          </div>
          <div class="w-full bg-gray-100 rounded-full h-2">
            <div class="bg-green-400 h-2 rounded-full" style="width: ${hv > 0 ? Math.min(100, Math.round(ps/hv*100)) : 0}%"></div>
          </div>
        </div>
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-gray-600">Abandoned (cancelled)</span>
            <span class="font-medium text-red-500">${pc} <span class="text-gray-400 font-normal">(${abandRate}% of started)</span></span>
          </div>
          <div class="w-full bg-gray-100 rounded-full h-2">
            <div class="bg-red-300 h-2 rounded-full" style="width: ${hv > 0 ? Math.min(100, Math.round(pc/hv*100)) : 0}%"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Daily Breakdown -->
    ${daily.length > 0 ? `
    <div class="bg-white rounded-xl border border-gray-100 overflow-hidden mb-6">
      <div class="px-6 py-4 border-b border-gray-50">
        <h2 class="font-semibold text-gray-900">Daily Breakdown (14 days)</h2>
      </div>
      <table class="w-full">
        <thead class="bg-gray-50">
          <tr>
            <th class="py-2 px-4 text-left text-xs font-medium text-gray-500">Date</th>
            <th class="py-2 px-4 text-center text-xs font-medium text-gray-500">Checkout Started</th>
            <th class="py-2 px-4 text-center text-xs font-medium text-green-600">Payments</th>
            <th class="py-2 px-4 text-center text-xs font-medium text-red-400">Cancelled</th>
          </tr>
        </thead>
        <tbody>${dailyRows}</tbody>
      </table>
    </div>` : ''}

    <!-- Recent Events -->
    <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-50">
        <h2 class="font-semibold text-gray-900">Recent Events</h2>
      </div>
      <table class="w-full">
        <thead class="bg-gray-50">
          <tr>
            <th class="py-2 px-4 text-left text-xs font-medium text-gray-500">Event</th>
            <th class="py-2 px-4 text-left text-xs font-medium text-gray-500">Email</th>
            <th class="py-2 px-4 text-left text-xs font-medium text-gray-500">Page</th>
            <th class="py-2 px-4 text-left text-xs font-medium text-gray-500">Time</th>
          </tr>
        </thead>
        <tbody>${recentRows || '<tr><td colspan="4" class="py-8 text-center text-sm text-gray-400">No events yet</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).send('Error loading analytics');
  }
});

// ── Helpers ─────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function timeSince(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

// ── Error Handling ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Start Server ───────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Syncline running on port ${PORT}`));
  })
  .catch(err => {
    console.error('DB init failed:', err);
    app.listen(PORT, () => console.log(`Syncline running on port ${PORT} (DB init failed)`));
  });

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});
