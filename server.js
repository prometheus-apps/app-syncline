const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
const sql = neon(process.env.DATABASE_URL);

const PRICE_ID = 'price_1TAAvK4Ho2w0775bzsm1kDMb';
const APP_URL = process.env.APP_URL || 'https://app-syncline.onrender.com';

// ── Stripe Webhook (MUST come BEFORE express.json()) ──────
app.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`Stripe event received: ${event.type}`);

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const email = session.customer_email || session.customer_details?.email || '';
          const amountTotal = session.amount_total || 0;
          const sessionId = session.id;

          // Record the successful payment
          await sql`
            INSERT INTO payments (stripe_session_id, email, amount_cents, status, created_at)
            VALUES (${sessionId}, ${email}, ${amountTotal}, 'succeeded', NOW())
            ON CONFLICT (stripe_session_id) DO UPDATE SET status = 'succeeded'
          `;

          // Mark user as paid if they exist
          if (email) {
            await sql`
              UPDATE users SET paid = true, paid_at = NOW()
              WHERE email = ${email}
            `;
          }

          console.log(`Payment succeeded: ${email} paid $${(amountTotal / 100).toFixed(2)}`);
          break;
        }

        case 'payment_intent.payment_failed': {
          const pi = event.data.object;
          const email = pi.last_payment_error?.payment_method?.billing_details?.email || '';
          const reason = pi.last_payment_error?.message || 'unknown';

          // Record the failed payment attempt
          await sql`
            INSERT INTO payments (stripe_session_id, email, amount_cents, status, failure_reason, created_at)
            VALUES (${pi.id}, ${email}, ${pi.amount || 0}, 'failed', ${reason}, NOW())
            ON CONFLICT (stripe_session_id) DO UPDATE SET status = 'failed', failure_reason = ${reason}
          `;

          console.log(`Payment failed for ${email}: ${reason}`);
          break;
        }

        case 'payment_intent.succeeded': {
          const pi = event.data.object;
          console.log(`PaymentIntent succeeded: ${pi.id} amount: $${(pi.amount / 100).toFixed(2)}`);
          break;
        }

        case 'charge.refunded': {
          const charge = event.data.object;
          const sessionId = charge.payment_intent;
          await sql`
            UPDATE payments SET status = 'refunded'
            WHERE stripe_session_id = ${sessionId}
          `;
          console.log(`Charge refunded: ${charge.id}`);
          break;
        }

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }
    } catch (dbErr) {
      console.error('DB error handling webhook:', dbErr.message);
      // Still return 200 so Stripe doesn't retry indefinitely
    }

    res.json({ received: true });
  }
);

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database Migration ─────────────────────────────────────
async function initDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE NOT NULL,
      paid BOOLEAN DEFAULT false,
      paid_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      stripe_session_id TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      amount_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      failure_reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS standups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      email TEXT NOT NULL,
      did_yesterday TEXT,
      doing_today TEXT,
      blockers TEXT,
      submitted_at TIMESTAMP DEFAULT NOW()
    )
  `;

  console.log('Database initialized');
}

// ── Health Check ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'syncline' });
});

// ── Main App ───────────────────────────────────────────────
app.get('/', async (req, res) => {
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
      <button data-checkout="true" class="bg-pink-500 text-white px-8 py-3 rounded-lg font-semibold hover:bg-pink-600 transition-colors text-lg">
        Unlock Syncline — $1
      </button>
    </div>
  </div>
</body>
</html>`);
});

// ── Standup Form ───────────────────────────────────────────
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

// ── Dashboard ──────────────────────────────────────────────
app.get('/dashboard', async (req, res) => {
  try {
    const standups = await sql`
      SELECT s.*, u.name FROM standups s
      LEFT JOIN users u ON s.user_id = u.id
      ORDER BY s.submitted_at DESC
      LIMIT 50
    `;

    const blockers = standups.filter(s => s.blockers && s.blockers.trim());

    const rows = standups.map(s => {
      const date = new Date(s.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const hasBlocker = s.blockers && s.blockers.trim();
      return `
        <div class="bg-white rounded-xl border border-gray-100 p-6 ${ hasBlocker ? 'border-l-4 border-l-orange-400' : '' }">
          <div class="flex items-start justify-between mb-4">
            <div>
              <div class="font-semibold text-gray-900">${escapeHtml(s.email)}</div>
              <div class="text-xs text-gray-400 mt-0.5">${date}</div>
            </div>
            ${hasBlocker ? '<span class="text-xs bg-orange-100 text-orange-600 px-2 py-1 rounded-full font-medium">🚧 Blocked</span>' : ''}
          </div>
          ${s.did_yesterday ? `<div class="mb-3"><div class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Yesterday</div><p class="text-sm text-gray-700">${escapeHtml(s.did_yesterday)}</p></div>` : ''}
          ${s.doing_today ? `<div class="mb-3"><div class="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Today</div><p class="text-sm text-gray-700">${escapeHtml(s.doing_today)}</p></div>` : ''}
          ${hasBlocker ? `<div><div class="text-xs font-medium text-orange-500 uppercase tracking-wide mb-1">Blocker</div><p class="text-sm text-orange-700">${escapeHtml(s.blockers)}</p></div>` : ''}
        </div>
      `;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Feed — Syncline</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
</head>
<body class="bg-gray-50 min-h-screen">
  <nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
    <a href="/" class="font-bold text-gray-900">Syncline</a>
    <a href="/standup" class="bg-pink-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pink-600">Post Standup</a>
  </nav>
  <div class="max-w-2xl mx-auto px-6 py-8">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">Team Feed</h1>
      <span class="text-sm text-gray-500">${standups.length} updates · ${blockers.length} blockers</span>
    </div>
    ${standups.length === 0 ? '<div class="text-center text-gray-400 py-16"><div class="text-4xl mb-4">📋</div><p>No standups yet. Be the first to post!</p><a href="/standup" class="mt-4 inline-block bg-pink-500 text-white px-6 py-2 rounded-lg">Post Standup</a></div>' : `<div class="space-y-4">${rows}</div>`}
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Error loading dashboard');
  }
});

// Helper: escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Stripe Checkout ────────────────────────────────────────
app.post('/api/checkout', async (req, res) => {
  try {
    const { email } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price: PRICE_ID,
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/cancel`,
      customer_email: email || undefined,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ success: false, error: 'Checkout failed' });
  }
});

// ── Success / Cancel Pages ─────────────────────────────────
app.get('/success', async (req, res) => {
  const { session_id } = req.query;
  let email = '';

  if (session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      email = session.customer_email || session.customer_details?.email || '';
    } catch (err) {
      console.error('Session verification failed:', err.message);
    }
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Successful — Syncline</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center">
  <div class="text-center p-8 max-w-md">
    <div class="text-6xl mb-6">✅</div>
    <h1 class="text-3xl font-bold text-gray-900 mb-3">You're in!</h1>
    <p class="text-gray-500 mb-2">Payment confirmed${email ? ` for <strong>${escapeHtml(email)}</strong>` : ''}.</p>
    <p class="text-gray-500 mb-8">Welcome to Syncline — let's get your team aligned.</p>
    <div class="flex flex-col sm:flex-row gap-3 justify-center">
      <a href="/standup" class="bg-pink-500 text-white px-6 py-3 rounded-lg font-semibold hover:bg-pink-600">Post Your First Standup</a>
      <a href="/dashboard" class="bg-white text-gray-700 px-6 py-3 rounded-lg font-semibold border border-gray-200 hover:bg-gray-50">View Team Feed</a>
    </div>
  </div>
</body>
</html>`);
});

app.get('/cancel', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Cancelled — Syncline</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
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

// ── Standup API ────────────────────────────────────────────
app.post('/api/standup', async (req, res) => {
  const { email, did_yesterday, doing_today, blockers } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, error: 'Email is required' });
  }
  try {
    // Upsert user
    const [user] = await sql`
      INSERT INTO users (email) VALUES (${email})
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `;

    await sql`
      INSERT INTO standups (user_id, email, did_yesterday, doing_today, blockers)
      VALUES (${user.id}, ${email}, ${did_yesterday || ''}, ${doing_today || ''}, ${blockers || ''})
    `;

    res.json({ success: true });
  } catch (err) {
    console.error('Standup error:', err);
    res.status(500).json({ success: false, error: 'Failed to submit standup' });
  }
});

app.get('/api/standups', async (req, res) => {
  try {
    const standups = await sql`
      SELECT id, email, did_yesterday, doing_today, blockers, submitted_at
      FROM standups ORDER BY submitted_at DESC LIMIT 100
    `;
    res.json({ success: true, data: standups });
  } catch (err) {
    console.error('Error fetching standups:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch standups' });
  }
});

// ── Admin: payments overview ───────────────────────────────
app.get('/admin/payments', async (req, res) => {
  try {
    const payments = await sql`
      SELECT * FROM payments ORDER BY created_at DESC LIMIT 100
    `;
    const total = payments.filter(p => p.status === 'succeeded').reduce((sum, p) => sum + p.amount_cents, 0);

    const rows = payments.map(p => `
      <tr class="border-b border-gray-100">
        <td class="py-3 px-4 text-sm text-gray-600">${escapeHtml(p.email) || '—'}</td>
        <td class="py-3 px-4 text-sm">$${(p.amount_cents / 100).toFixed(2)}</td>
        <td class="py-3 px-4">
          <span class="text-xs px-2 py-1 rounded-full font-medium ${
            p.status === 'succeeded' ? 'bg-green-100 text-green-700' :
            p.status === 'failed' ? 'bg-red-100 text-red-700' :
            p.status === 'refunded' ? 'bg-yellow-100 text-yellow-700' :
            'bg-gray-100 text-gray-600'
          }">${escapeHtml(p.status)}</span>
        </td>
        <td class="py-3 px-4 text-sm text-gray-400">${new Date(p.created_at).toLocaleDateString()}</td>
        <td class="py-3 px-4 text-xs text-gray-400 font-mono">${escapeHtml(p.failure_reason || '')}</td>
      </tr>
    `).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payments — Syncline Admin</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
</head>
<body class="bg-gray-50 min-h-screen p-8">
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">Payment History</h1>
      <span class="text-sm text-gray-500">Total revenue: <strong class="text-green-600">$${(total / 100).toFixed(2)}</strong></span>
    </div>
    <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <table class="w-full">
        <thead class="bg-gray-50">
          <tr>
            <th class="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">Email</th>
            <th class="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">Amount</th>
            <th class="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">Status</th>
            <th class="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">Date</th>
            <th class="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">Failure Reason</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="5" class="text-center py-8 text-gray-400">No payments yet</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('Admin payments error:', err);
    res.status(500).send('Error loading payments');
  }
});

// ── Error Handling ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Start Server ───────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Syncline server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('DB init failed:', err);
    app.listen(PORT, () => {
      console.log(`Syncline server running on port ${PORT} (DB init failed)`);
    });
  });

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});
