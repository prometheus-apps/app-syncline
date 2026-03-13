var express = require('express');
var cors = require('cors');
var neon = require('@neondatabase/serverless').neon;
var path = require('path');

var app = express();
var PORT = process.env.PORT || 3000;

// Only connect to DB if DATABASE_URL is set
var sql = null;
if (process.env.DATABASE_URL) {
  sql = neon(process.env.DATABASE_URL);
}

// Stripe - only init if key present
var stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Escape HTML
function esc(str) {
  if (!str && str !== 0) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

function timeSince(date) {
  var sec = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec/60) + 'm ago';
  if (sec < 86400) return Math.floor(sec/3600) + 'h ago';
  return Math.floor(sec/86400) + 'd ago';
}

function wrap(title, body) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>' + esc(title) + '</title><script src="https://cdn.tailwindcss.com"></scr' + 'ipt></head><body class="bg-gray-50 min-h-screen">' + body + '</body></html>';
}

// Init DB tables
async function initDB() {
  if (!sql) { console.log('No DATABASE_URL, skipping DB init'); return; }
  await sql(['CREATE TABLE IF NOT EXISTS standups (id SERIAL PRIMARY KEY, email TEXT NOT NULL, did_yesterday TEXT DEFAULT \'\', doing_today TEXT DEFAULT \'\', blockers TEXT DEFAULT \'\', created_at TIMESTAMP DEFAULT NOW())']);
  await sql(['CREATE TABLE IF NOT EXISTS analytics_events (id SERIAL PRIMARY KEY, event_name TEXT NOT NULL, session_id TEXT, user_email TEXT, page TEXT, metadata JSONB DEFAULT \'{}\', created_at TIMESTAMP DEFAULT NOW())']);
  console.log('DB ready');
}

// Track analytics event
async function track(name, opts) {
  if (!sql) return;
  try {
    opts = opts || {};
    await sql(['INSERT INTO analytics_events (event_name, session_id, user_email, page, metadata) VALUES ($1,$2,$3,$4,$5)', name, opts.sessionId||null, opts.userEmail||null, opts.page||null, JSON.stringify(opts.meta||{})]);
  } catch(e) { console.error('track err:', e.message); }
}

app.get('/health', function(req, res) { res.json({ status: 'ok' }); });

app.post('/api/track', async function(req, res) {
  var allowed = ['page_view','checkout_started','standup_submitted'];
  var event = req.body.event;
  if (!event || allowed.indexOf(event) === -1) return res.status(400).json({ success:false, error:'Invalid event' });
  await track(event, { page: req.body.page||null, sessionId: req.body.sessionId||null });
  res.json({ success: true });
});

app.get('/', function(req, res) {
  var html = wrap('Syncline \u2014 Async Standup Tool',
    '<nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">'
    +'<div class="flex items-center gap-2"><span class="text-xl font-bold text-gray-900">Syncline</span><span class="text-xs bg-pink-100 text-pink-600 px-2 py-0.5 rounded-full font-medium">Beta</span></div>'
    +'<div class="flex items-center gap-4"><a href="/dashboard" class="text-sm text-gray-600 hover:text-gray-900">Dashboard</a><a href="/standup" class="bg-pink-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pink-600">Post Standup</a></div></nav>'
    +'<div class="max-w-2xl mx-auto px-6 py-16 text-center">'
    +'<h1 class="text-4xl font-bold text-gray-900 mb-4">Align your team<br/>without the meeting.</h1>'
    +'<p class="text-lg text-gray-500 mb-8">Syncline lets remote engineering teams run async standups, surface blockers, and stay aligned.</p>'
    +'<div class="flex flex-col sm:flex-row gap-3 justify-center mb-16">'
    +'<a href="/standup" class="bg-pink-500 text-white px-8 py-3 rounded-lg font-semibold hover:bg-pink-600">Post Your Standup</a>'
    +'<a href="/dashboard" class="bg-white text-gray-700 px-8 py-3 rounded-lg font-semibold border border-gray-200 hover:bg-gray-50">View Team Feed</a>'
    +'</div>'
    +'<div class="grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">'
    +'<div class="bg-white rounded-xl p-6 border border-gray-100"><div class="text-2xl mb-3">&#x1F4CB;</div><h3 class="font-semibold text-gray-900 mb-1">Async Standups</h3><p class="text-sm text-gray-500">Post what you did, what you&#39;re doing, and any blockers on your own schedule.</p></div>'
    +'<div class="bg-white rounded-xl p-6 border border-gray-100"><div class="text-2xl mb-3">&#x1F6A7;</div><h3 class="font-semibold text-gray-900 mb-1">Blocker Tracking</h3><p class="text-sm text-gray-500">Surface blockers so your team can help without waiting for the next sync.</p></div>'
    +'<div class="bg-white rounded-xl p-6 border border-gray-100"><div class="text-2xl mb-3">&#x1F517;</div><h3 class="font-semibold text-gray-900 mb-1">Team Alignment</h3><p class="text-sm text-gray-500">Everyone stays in the loop. No meetings. No Slack interruptions.</p></div>'
    +'</div>'
    +'<div class="mt-16 bg-pink-50 border border-pink-100 rounded-2xl p-8">'
    +'<h2 class="text-2xl font-bold text-gray-900 mb-2">Get full access &#x2014; $1</h2>'
    +'<p class="text-gray-500 mb-6">One-time payment. No subscription. No catch.</p>'
    +'<button id="cbtn" data-checkout="true" class="bg-pink-500 text-white px-8 py-3 rounded-lg font-semibold hover:bg-pink-600 text-lg">Unlock Syncline &#x2014; $1</button>'
    +'</div></div>'
    +'<script>(function(){var s=sessionStorage.getItem("_sid")||("s"+Date.now().toString(36));sessionStorage.setItem("_sid",s);fetch("/api/track",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:"page_view",page:"/",sessionId:s})}).catch(function(){});var b=document.getElementById("cbtn");if(b){b.addEventListener("click",function(){fetch("/api/track",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:"checkout_started",page:"/",sessionId:s})}).catch(function(){});},true);}})();</scr'+'ipt>'
  );
  res.send(html);
});

app.get('/standup', function(req, res) {
  res.send(wrap('Post Standup \u2014 Syncline',
    '<nav class="bg-white border-b border-gray-100 px-6 py-4"><a href="/" class="font-bold text-gray-900">&#x2190; Syncline</a></nav>'
    +'<div class="max-w-xl mx-auto px-6 py-10">'
    +'<h1 class="text-2xl font-bold text-gray-900 mb-2">Post your standup</h1>'
    +'<p class="text-gray-500 mb-8">Takes 2 minutes. Your team will see it instantly.</p>'
    +'<form id="sf" class="space-y-5">'
    +'<div><label class="block text-sm font-medium text-gray-700 mb-1">Your email</label><input type="email" name="email" required placeholder="you@company.com" class="w-full border border-gray-200 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-pink-400"></div>'
    +'<div><label class="block text-sm font-medium text-gray-700 mb-1">What did you do yesterday?</label><textarea name="did_yesterday" rows="3" placeholder="Shipped the auth refactor..." class="w-full border border-gray-200 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-pink-400"></textarea></div>'
    +'<div><label class="block text-sm font-medium text-gray-700 mb-1">What are you doing today?</label><textarea name="doing_today" rows="3" placeholder="Working on the billing integration..." class="w-full border border-gray-200 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-pink-400"></textarea></div>'
    +'<div><label class="block text-sm font-medium text-gray-700 mb-1">Any blockers? <span class="text-gray-400">(optional)</span></label><textarea name="blockers" rows="2" class="w-full border border-gray-200 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-pink-400"></textarea></div>'
    +'<button type="submit" class="w-full bg-pink-500 text-white py-3 rounded-lg font-semibold hover:bg-pink-600">Post Standup</button>'
    +'</form>'
    +'<div id="ok" class="hidden mt-6 bg-green-50 border border-green-200 rounded-lg p-4 text-green-700 text-center">&#x2705; Standup posted! <a href="/dashboard" class="underline">View team feed &#x2192;</a></div>'
    +'<div id="er" class="hidden mt-6 bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-center"></div>'
    +'</div>'
    +'<script>(function(){var s=sessionStorage.getItem("_sid")||("s"+Date.now().toString(36));sessionStorage.setItem("_sid",s);fetch("/api/track",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:"page_view",page:"/standup",sessionId:s})}).catch(function(){});document.getElementById("sf").addEventListener("submit",function(e){e.preventDefault();var d={};new FormData(e.target).forEach(function(v,k){d[k]=v;});fetch("/api/standup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)}).then(function(r){return r.json();}).then(function(j){if(j.success){e.target.classList.add("hidden");document.getElementById("ok").classList.remove("hidden");}else{var el=document.getElementById("er");el.textContent=j.error||"Error";el.classList.remove("hidden");}}).catch(function(){document.getElementById("er").textContent="Network error";document.getElementById("er").classList.remove("hidden");});});})();</scr'+'ipt>'
  ));
});

app.post('/api/standup', async function(req, res) {
  if (!sql) return res.status(503).json({ success:false, error:'Database not configured' });
  var email = req.body.email;
  if (!email) return res.status(400).json({ success:false, error:'Email is required' });
  try {
    var rows = await sql(['INSERT INTO standups (email,did_yesterday,doing_today,blockers) VALUES ($1,$2,$3,$4) RETURNING id,email,created_at', email, req.body.did_yesterday||'', req.body.doing_today||'', req.body.blockers||'']);
    res.json({ success:true, data:rows[0] });
  } catch(e) { console.error(e); res.status(500).json({ success:false, error:'Failed to save' }); }
});

app.post('/api/checkout', async function(req, res) {
  if (!stripe) return res.status(503).json({ success:false, error:'Payments not configured' });
  try {
    var session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency:'usd', product_data:{ name:'Syncline - Full Access', description:'One-time payment.' }, unit_amount:100 }, quantity:1 }],
      mode: 'payment',
      success_url: req.protocol+'://'+req.get('host')+'/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: req.protocol+'://'+req.get('host')+'/cancel',
      customer_email: req.body.email||undefined
    });
    await track('checkout_started', { sessionId:req.body.sessionId||null, userEmail:req.body.email||null, page:'/api/checkout', meta:{ stripe_session_id:session.id } });
    res.json({ url: session.url });
  } catch(e) { console.error(e); res.status(500).json({ success:false, error:'Checkout failed' }); }
});

app.get('/success', async function(req, res) {
  var sessionId = req.query.session_id||null;
  var userEmail = null;
  if (sessionId && stripe) {
    try { var s = await stripe.checkout.sessions.retrieve(sessionId); userEmail = s.customer_email||null; } catch(e) {}
  }
  await track('payment_success', { userEmail:userEmail, page:'/success', meta:{ session_id:sessionId } });
  res.send(wrap('Payment Successful \u2014 Syncline',
    '<div class="min-h-screen flex items-center justify-center"><div class="text-center p-8 max-w-md">'
    +'<div class="text-6xl mb-6">&#x2705;</div>'
    +'<h1 class="text-3xl font-bold text-gray-900 mb-3">You&#39;re in!</h1>'
    +'<p class="text-gray-500 mb-2">Payment confirmed.</p>'
    +'<p class="text-gray-500 mb-8">Welcome to Syncline.</p>'
    +'<div class="flex flex-col sm:flex-row gap-3 justify-center">'
    +'<a href="/standup" class="bg-pink-500 text-white px-6 py-3 rounded-lg font-semibold hover:bg-pink-600">Post Your First Standup</a>'
    +'<a href="/dashboard" class="bg-white text-gray-700 px-6 py-3 rounded-lg font-semibold border border-gray-200">View Team Feed</a>'
    +'</div></div></div>'
  ));
});

app.get('/cancel', async function(req, res) {
  await track('payment_cancelled', { page:'/cancel', meta:{} });
  res.send(wrap('Payment Cancelled \u2014 Syncline',
    '<div class="min-h-screen flex items-center justify-center"><div class="text-center p-8 max-w-md">'
    +'<div class="text-6xl mb-6">&#x1F4B8;</div>'
    +'<h1 class="text-3xl font-bold text-gray-900 mb-3">Payment cancelled</h1>'
    +'<p class="text-gray-500 mb-8">No worries &#8212; you haven&#39;t been charged.</p>'
    +'<a href="/" class="bg-pink-500 text-white px-6 py-3 rounded-lg font-semibold hover:bg-pink-600">Back to Syncline</a>'
    +'</div></div>'
  ));
});

app.get('/dashboard', async function(req, res) {
  if (!sql) return res.send(wrap('Team Feed \u2014 Syncline','<div class="text-center py-16 text-gray-400"><p>Database not connected</p></div>'));
  try {
    var rows = await sql(['SELECT id,email,did_yesterday,doing_today,blockers,created_at FROM standups ORDER BY created_at DESC LIMIT 50']);
    var cards = '';
    var bcnt = 0;
    for (var i=0; i<rows.length; i++) {
      var r = rows[i];
      var hasB = r.blockers && r.blockers.trim();
      if (hasB) bcnt++;
      var init = r.email && r.email.length>0 ? r.email[0].toUpperCase() : '?';
      cards += '<div class="bg-white rounded-xl border border-gray-100 p-5">';
      cards += '<div class="flex items-center justify-between mb-3"><div class="flex items-center gap-2">';
      cards += '<div class="w-8 h-8 rounded-full bg-pink-100 flex items-center justify-center text-sm font-semibold text-pink-600">'+esc(init)+'</div>';
      cards += '<span class="font-medium text-gray-900 text-sm">'+esc(r.email)+'</span></div>';
      cards += '<span class="text-xs text-gray-400">'+timeSince(r.created_at)+'</span></div>';
      if (r.did_yesterday) cards += '<div class="mb-2"><span class="text-xs font-medium text-gray-400 uppercase">Yesterday</span><p class="text-sm text-gray-700 mt-0.5">'+esc(r.did_yesterday)+'</p></div>';
      if (r.doing_today) cards += '<div class="mb-2"><span class="text-xs font-medium text-gray-400 uppercase">Today</span><p class="text-sm text-gray-700 mt-0.5">'+esc(r.doing_today)+'</p></div>';
      if (hasB) cards += '<div class="mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><span class="text-xs font-semibold text-amber-600">&#x1F6A7; Blocker:</span><p class="text-sm text-amber-800 mt-0.5">'+esc(r.blockers)+'</p></div>';
      cards += '</div>';
    }
    if (!cards) cards = '<div class="text-center py-16 text-gray-400"><p>No standups yet. <a href="/standup" class="text-pink-500 underline">Post the first one.</a></p></div>';
    res.send(wrap('Team Feed \u2014 Syncline',
      '<nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">'
      +'<a href="/" class="font-bold text-gray-900">&#x2190; Syncline</a>'
      +'<a href="/standup" class="bg-pink-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-pink-600">Post Standup</a></nav>'
      +'<div class="max-w-2xl mx-auto px-6 py-8">'
      +'<div class="flex items-center justify-between mb-6"><h1 class="text-2xl font-bold text-gray-900">Team Feed</h1>'
      +'<span class="text-sm text-gray-500">'+rows.length+' update'+(rows.length!==1?'s':'')+(bcnt>0?' &bull; <span class="text-amber-600">'+bcnt+' blocker'+(bcnt!==1?'s':'')+'</span>':'')+'</span></div>'
      +'<div class="space-y-4">'+cards+'</div></div>'
    ));
  } catch(e) {
    console.error('dashboard err:',e);
    res.status(500).send('Error loading dashboard');
  }
});

app.get('/analytics', async function(req, res) {
  if (!sql) return res.send(wrap('Analytics \u2014 Syncline','<div class="text-center py-16 text-gray-400"><p>Database not connected</p></div>'));
  try {
    var c = (await sql(['SELECT COUNT(*) FILTER (WHERE event_name=\'page_view\' AND page=\'/\') AS hv, COUNT(*) FILTER (WHERE event_name=\'checkout_started\') AS cs, COUNT(*) FILTER (WHERE event_name=\'payment_success\') AS ps, COUNT(*) FILTER (WHERE event_name=\'payment_cancelled\') AS pc FROM analytics_events WHERE created_at > NOW()-INTERVAL\'30 days\'']))[0]||{};
    var hv=parseInt(c.hv)||0, cs=parseInt(c.cs)||0, ps=parseInt(c.ps)||0, pc=parseInt(c.pc)||0;
    var conv = cs>0 ? Math.round(ps/cs*100)+'%' : 'N/A';
    var aband = cs>0 ? Math.round(pc/cs*100)+'%' : 'N/A';
    var recent = await sql(['SELECT event_name,user_email,page,created_at FROM analytics_events ORDER BY created_at DESC LIMIT 20']);
    var badgeClass = { page_view:'bg-gray-100 text-gray-600', checkout_started:'bg-blue-100 text-blue-700', payment_success:'bg-green-100 text-green-700', payment_cancelled:'bg-red-100 text-red-600' };
    var evRows = '';
    for (var i=0;i<recent.length;i++) {
      var e=recent[i], bc=badgeClass[e.event_name]||'bg-gray-100 text-gray-600';
      var t=new Date(e.created_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      evRows+='<tr class="border-b border-gray-50"><td class="py-2 px-4"><span class="text-xs px-2 py-0.5 rounded-full font-medium '+bc+'">'+esc(e.event_name)+'</span></td><td class="py-2 px-4 text-xs text-gray-500">'+esc(e.user_email||'&#8212;')+'</td><td class="py-2 px-4 text-xs text-gray-400">'+esc(e.page||'&#8212;')+'</td><td class="py-2 px-4 text-xs text-gray-400">'+t+'</td></tr>';
    }
    if (!evRows) evRows='<tr><td colspan="4" class="py-8 text-center text-sm text-gray-400">No events yet</td></tr>';
    var funnel=''; 
    var fsteps=[['Homepage Views',hv,'bg-gray-400'],['Checkout Started',cs,'bg-blue-400'],['Payment Success',ps,'bg-green-400'],['Payment Cancelled',pc,'bg-red-300']];
    for (var j=0;j<fsteps.length;j++) {
      var fs=fsteps[j], pct=hv>0?Math.min(100,Math.round(fs[1]/hv*100)):0;
      funnel+='<div class="mb-3"><div class="flex justify-between text-sm mb-1"><span class="text-gray-600">'+fs[0]+'</span><span class="font-medium">'+fs[1]+'</span></div><div class="w-full bg-gray-100 rounded-full h-2"><div class="'+fs[2]+' h-2 rounded-full" style="width:'+pct+'%"></div></div></div>';
    }
    res.send(wrap('Analytics \u2014 Syncline',
      '<nav class="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between"><a href="/" class="font-bold text-gray-900">&#x2190; Syncline</a><span class="text-sm text-gray-500">Analytics</span></nav>'
      +'<div class="max-w-4xl mx-auto px-6 py-8">'
      +'<h1 class="text-2xl font-bold text-gray-900 mb-1">Checkout Analytics</h1>'
      +'<p class="text-sm text-gray-500 mb-8">Last 30 days</p>'
      +'<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">'
      +'<div class="bg-white rounded-xl border border-gray-100 p-5"><p class="text-sm text-gray-500">Homepage Views</p><p class="text-3xl font-bold text-gray-900">'+hv+'</p></div>'
      +'<div class="bg-white rounded-xl border border-gray-100 p-5"><p class="text-sm text-gray-500">Checkout Started</p><p class="text-3xl font-bold text-blue-600">'+cs+'</p></div>'
      +'<div class="bg-white rounded-xl border border-gray-100 p-5"><p class="text-sm text-gray-500">Payments Done</p><p class="text-3xl font-bold text-green-600">'+ps+'</p></div>'
      +'<div class="bg-white rounded-xl border border-gray-100 p-5"><p class="text-sm text-gray-500">Cancelled</p><p class="text-3xl font-bold text-red-500">'+pc+'</p></div>'
      +'<div class="bg-white rounded-xl border border-gray-100 p-5"><p class="text-sm text-gray-500">Conversion</p><p class="text-3xl font-bold text-gray-900">'+conv+'</p><p class="text-xs text-gray-400">started&#x2192;paid</p></div>'
      +'<div class="bg-white rounded-xl border border-gray-100 p-5"><p class="text-sm text-gray-500">Abandonment</p><p class="text-3xl font-bold text-gray-900">'+aband+'</p><p class="text-xs text-gray-400">started&#x2192;cancelled</p></div>'
      +'</div>'
      +'<div class="bg-white rounded-xl border border-gray-100 p-6 mb-6"><h2 class="font-semibold text-gray-900 mb-4">Checkout Funnel</h2>'+funnel+'</div>'
      +'<div class="bg-white rounded-xl border border-gray-100 overflow-hidden">'
      +'<div class="px-6 py-4 border-b border-gray-50"><h2 class="font-semibold text-gray-900">Recent Events</h2></div>'
      +'<table class="w-full"><thead class="bg-gray-50"><tr><th class="py-2 px-4 text-left text-xs text-gray-500">Event</th><th class="py-2 px-4 text-left text-xs text-gray-500">Email</th><th class="py-2 px-4 text-left text-xs text-gray-500">Page</th><th class="py-2 px-4 text-left text-xs text-gray-500">Time</th></tr></thead>'
      +'<tbody>'+evRows+'</tbody></table></div>'
      +'</div>'
    ));
  } catch(e) { console.error('analytics err:',e); res.status(500).send('Error loading analytics'); }
});

app.use(function(err,req,res,next) {
  console.error(err.stack);
  res.status(500).json({ success:false, error:'Internal error' });
});

initDB().catch(function(e) { console.error('initDB failed:',e.message); });

app.listen(PORT, function() { console.log('Syncline on port '+PORT); });

process.on('SIGTERM', function() { process.exit(0); });
