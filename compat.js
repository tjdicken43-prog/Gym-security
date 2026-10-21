// Will SecurityAI work at this gym? The answers a gym owner gives on the
// "Check your gym" page (check.html), turned into a plain verdict, before
// anyone pays. Used by the page (instant answer) and the website (the copy
// emailed to TJ), so both always say the same thing.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Compat = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Recorders (NVR/DVR) that share a camera's video with other software (RTSP).
  const NVR_OK = ['hikvision', 'dahua', 'lorex', 'reolink', 'amcrest', 'uniview', 'annke', 'axis', 'hanwha', 'avigilon', 'unifi', 'milestone', 'blue iris', 'synology'];
  const NVR_MAYBE = ['swann', 'night owl', 'q-see', 'zosi', 'defender'];   // some models do, some don't
  const CLOUD_NO = ['ring', 'wyze', 'blink', 'arlo', 'nest', 'eufy', 'simplisafe', 'adt'];
  const CLOUD_MAYBE = ['verkada', 'meraki', 'eagle eye', 'rhombus', 'openpath'];
  const CHECKIN_FEED = ['abc', 'mindbody', 'clubready', 'zen planner', 'wodify', 'pushpress', 'club os', 'daxko', 'glofox', 'gym assistant', 'jonas', 'ezfacility'];

  const has = (list, v) => list.some(x => String(v || '').toLowerCase().includes(x));
  const L = (level, title, text) => ({ level, title, text });   // level: ok | fix | ask | no

  function verdict(a) {
    a = a || {};
    const items = [];
    // Cameras
    if (a.recorder === 'nvr') {
      if (has(NVR_OK, a.brand)) items.push(L('ok', 'Your recorder', `${a.brand} recorders share the entrance camera with SecurityAI. Nothing new to buy.`));
      else if (has(NVR_MAYBE, a.brand)) items.push(L('ask', 'Your recorder', `Some ${a.brand} models share video and some don't. A photo of the label on the recorder tells us which.`));
      else items.push(L('ask', 'Your recorder', 'Most recorders work. A photo of the label on the recorder tells us for sure.'));
    } else if (a.recorder === 'cloud') {
      if (has(CLOUD_NO, a.brand)) items.push(L('fix', 'Your cameras', `${a.brand || 'These'} cameras don't share video with other software. One compatible camera over the entrance (about $60–150) fixes it, and we can help pick it.`));
      else items.push(L('ask', 'Your cameras', `Business cloud cameras${a.brand ? ' like ' + a.brand : ''} can sometimes share a camera's video. We check with you on a call.`));
    } else items.push(L('ask', 'Your cameras', "Not sure what records them? A photo of the box in the back room (or the app you watch them in) tells us."));
    // The camera at the door
    if (a.angle === 'above') items.push(L('ok', 'The entrance camera', 'A camera above the turnstile or door, looking down, is the best view.'));
    else if (a.angle === 'side') items.push(L('fix', 'The entrance camera', 'From the side works, but two people close together can hide each other. A camera above the turnstile is more accurate.'));
    else if (a.angle === 'none') items.push(L('fix', 'The entrance camera', 'There needs to be a camera that sees people come through. One camera over the entrance does it.'));
    else items.push(L('ask', 'The entrance camera', 'A screenshot of the entrance camera shows us the angle.'));
    // Check-ins. The reader learns any front-desk screen from one test scan:
    // a pop-up or card, a list of check-ins (newest at the top or the bottom),
    // or a welcome screen that only shows the member's name.
    const SHOWS = { popup: ' A pop-up works: each new member it shows counts as a scan.', list: ' A list of check-ins works: each new row counts as a scan, newest at the top or the bottom.',
      name: " A screen with only names works: the name is scrambled on the box, like a member number." };
    const shows = SHOWS[a.shows] || '';
    const sys = a.checkin || 'your system';
    if (/ashbourne/i.test(a.checkin || '')) items.push(L('ok', 'Your check-in system', 'Ashbourne is already supported: the front-desk screen is read as members scan.'));
    else if (a.desk === 'ipad') items.push(L('ok', 'Your check-in system', `An iPad shares its screen through a USB-C (or Lightning) to HDMI adapter, about $20–50, so the same small box reads ${sys} with nothing installed on the iPad.${shows}`));
    else if (a.desk === 'android' || a.desk === 'tablet') items.push(L('ask', 'Your check-in system', `Some Android tablets can share their screen over USB-C to HDMI (Samsung Galaxy Tab S models can); many can't. If yours can't, check-ins come from ${sys}'s own connection, if your account allows it. We check the model with you.`));
    else if (a.desk === 'none') items.push(L('ask', 'Your check-in system', `With no screen at the desk, check-ins come from ${sys}'s own connection (or the door system's), if your account allows it. We check that with you.`));
    else if (has(CHECKIN_FEED, a.checkin)) items.push(L('ok', 'Your check-in system', `${a.checkin} works: SecurityAI learns your front-desk screen on install day (one test scan), or uses ${a.checkin}'s own connection if your account allows it.${shows}`));
    else items.push(L('ok', 'Your check-in system', `${a.checkin ? a.checkin + ' works' : 'Any system works'}: SecurityAI learns your front-desk screen on install day (one test scan).${shows}`));
    // Internet
    if (a.wired === 'yes') items.push(L('ok', 'Internet', 'A wired connection near the recorder is ideal.'));
    else items.push(L('ok', 'Internet', 'Wi-Fi works. A cable to the router is more reliable if there is one nearby.'));
    const rank = { no: 3, fix: 2, ask: 1, ok: 0 };
    const worst = items.reduce((m, x) => Math.max(m, rank[x.level]), 0);
    const overall = worst >= 2 ? { level: 'fix', title: 'Works with a small change', text: 'One thing needs changing first. Everything else is ready.' }
      : worst === 1 ? { level: 'ask', title: 'Very likely: a quick check first', text: "A couple of photos or a 10-minute call and you'll have a yes or no." }
      : { level: 'ok', title: 'Ready to set up', text: 'Everything you described works with SecurityAI.' };
    return { overall, items };
  }
  return { verdict, NVR_OK, NVR_MAYBE, CLOUD_NO, CLOUD_MAYBE, CHECKIN_FEED };
}));
