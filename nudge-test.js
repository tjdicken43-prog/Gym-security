// Checks the "still waiting" reminder (nudge.js) with a made-up log: who
// gets it, which entries are listed, never twice, never at night.
//   node nudge-test.js
const N = require('./nudge');
const H = 3600e3; const now = Date.parse('2026-10-24T17:00:00Z'); // noon Central
const log = [
  { id: 'a', timestamp: new Date(now - 5*H).toISOString(), k: 'flag' },      // remind
  { id: 'b', timestamp: new Date(now - 1*H).toISOString(), k: 'flag' },      // too new
  { id: 'c', timestamp: new Date(now - 6*H).toISOString(), k: 'flag' },      // reviewed
  { id: 'd', timestamp: new Date(now - 6*H).toISOString(), k: 'normal' },    // not flagged
  { id: 'e', timestamp: new Date(now - 47*H).toISOString(), k: 'possible' }, // too old
  { id: 'f', timestamp: new Date(now - 10*H).toISOString(), k: 'possible' }, // remind
];
let markers = {}, sent = [];
const store = { loadReviews: () => ({ c: { verdict: 'fine' } }), getMarker: (k, n) => markers[n] || null, setMarker: (k, n, v) => { markers[n] = v; }, eventId: e => e.id, getSettings: () => ({}),
  loadSubscribers: () => [{ kind: 'email', to: 'x@y.co' }, { kind: 'email', to: 'off@y.co', morning: false }, { kind: 'sms', to: '+1' }] };
const monitor = { getLog: () => log, purgeAt: (k, e) => Date.parse(e.timestamp) + 48*H };
const gyms = { gymNameFor: () => 'Maple Street Fitness', publicBaseUrl: () => 'https://ex.com', timeZoneFor: () => 'America/Chicago' };
const n = N.create({ monitor, store, gyms, mailer: { isConfigured: () => true }, kindOf: e => e.k, send: async (k, s, m) => sent.push([s.to, m]) });
(async () => {
  let r = await n.tick(['g'], now);
  const ok = (c, w) => { console.log(c ? 'OK  ' : 'FAIL', w); if (!c) process.exitCode = 1; };
  ok(sent.length === 1 && sent[0][0] === 'x@y.co', 'one email, only to the opted-in email subscriber');
  ok(/2 flagged entries/.test(sent[0][1].subject) && /ev-a/.test(sent[0][1].text) && /ev-f/.test(sent[0][1].text) && !/ev-b|ev-c|ev-e/.test(sent[0][1].text), 'lists a and f only');
  ok(sent[0][1].kind === 'nudge', 'kind nudge');
  sent = []; await n.tick(['g'], now + 15*60e3); ok(sent.length === 0, 'never reminds twice');
  markers = {}; sent = []; await n.tick(['g'], Date.parse('2026-10-24T08:00:00Z')); ok(sent.length === 0, 'no reminder at 3 AM Central');
  console.log(sent.length ? '' : '\n' + (await (async()=>{markers={};sent=[];await n.tick(['g'],now);return sent[0][1].text})()));
})();
