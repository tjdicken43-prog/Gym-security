const fs = require('fs');

function check(path){
  const html = fs.readFileSync(path, 'utf8');
  console.log(`\n=== ${path} ===`);

  // 1. JS syntax check (all <script> blocks concatenated)
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  try {
    new Function(scripts.join('\n;\n'));
    console.log('[OK] JS syntax valid');
  } catch(e){
    console.log('[FAIL] JS syntax error:', e.message);
  }

  // 2. Every getElementById('X') / getElementById("X") has a matching id="X" in the HTML
  // (skips calls with template-literal interpolation like `${id}` — those are dynamic
  // IDs resolved at runtime, not something a static check can meaningfully verify)
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
  const referenced = new Set(
    [...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)]
      .map(m => m[1])
      .filter(id => !id.includes('${'))
  );
  const missing = [...referenced].filter(id => !ids.has(id));
  console.log(missing.length ? `[FAIL] getElementById refs with no matching id=: ${missing.join(', ')}` : '[OK] All getElementById refs resolve');

  // 3. Duplicate ids (invalid HTML, first match wins silently otherwise)
  const idList = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
  const dupes = idList.filter((id, i) => idList.indexOf(id) !== i);
  console.log(dupes.length ? `[FAIL] Duplicate id attributes: ${[...new Set(dupes)].join(', ')}` : '[OK] No duplicate ids');

  // 4. Rough tag balance for structural tags
  ['div','section','button','label'].forEach(tag => {
    const open = (html.match(new RegExp(`<${tag}(\\s|>)`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    console.log(open === close ? `[OK] <${tag}> balanced (${open})` : `[FAIL] <${tag}> mismatch: ${open} open vs ${close} close`);
  });

  // 5. onclick/onchange handlers reference functions actually defined
  const handlers = [...html.matchAll(/on(?:click|change)=["']([a-zA-Z0-9_]+)\(/g)].map(m => m[1]);
  const fnDefs = new Set([...html.matchAll(/function\s+([a-zA-Z0-9_]+)\s*\(/g)].map(m => m[1]));
  const missingFns = [...new Set(handlers)].filter(fn => !fnDefs.has(fn));
  console.log(missingFns.length ? `[FAIL] onclick/onchange calls undefined function(s): ${missingFns.join(', ')}` : '[OK] All onclick/onchange handlers resolve to defined functions');
}

process.argv.slice(2).forEach(check);
