// End-to-end check of web/chip-settle.html in headless Chromium.
// A fake Claude `sample` capability returns canned answers, so this runs the whole
// photo pipeline (load photo, locate seats, crop, parse counts) plus the settlement
// maths without calling Claude. Run: npm test
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const body = fs.readFileSync(path.join(root, 'web', 'chip-settle.html'), 'utf8');
// The Artifact platform wraps the page in this skeleton when it publishes it.
const shell = '<!doctype html><html><head><meta charset=utf8>'
  + '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>'
  + `</head><body>${body}</body></html>`;
const pageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chip-settle-')), 'page.html');
fs.writeFileSync(pageFile, shell);

const fakeClaude = () => {
  const W = 2576, H = 1932;
  const pct = (x0, y0, x1, y1) => [x0 / W, y0 / H, x1 / W, y1 / H].map((v) => +(v * 100).toFixed(1));
  const LOCATE = {
    seats: [
      { seat: 5, box: pct(1100, 1330, 1560, 1740), summary: '黄一排、紫一排、黑一排、蓝3枚' },
      { seat: 6, box: pct(200, 1270, 870, 1650), summary: '黑一排、蓝三排、紫4枚' },
      { seat: 10, box: pct(1200, 500, 1520, 820), summary: '蓝两排、黑、黄1、紫2' },
      { seat: 1, box: pct(1800, 550, 2130, 800), summary: '红一排、蓝一排、散的黄紫黑' },
      { seat: 3, box: pct(1980, 1060, 2340, 1330), summary: '蓝一排、红5枚' },
    ],
    unassigned: '',
  };
  const COUNTS = {
    5: { piles: [{ color: 'yellow', count: 11, confidence: 'medium' }, { color: 'purple', count: 10 }, { color: 'black', count: 16 }, { color: 'blue', count: 3 }] },
    6: { piles: [{ color: 'black', count: 10 }, { color: 'blue', count: 13 }, { color: 'blue', count: 11 }, { color: 'blue', count: 10 }, { color: 'Purple', count: 4 }] },
    // 47 blue instead of the true 44: the page should flag "+30, 3 blue too many".
    10: { piles: [{ color: 'blue', count: 21, confidence: 'low' }, { color: 'blue', count: 26, confidence: 'low' }, { color: 'black', count: 6 }, { color: 'yellow', count: 1 }, { color: 'purple', count: 2 }] },
    1: { piles: [{ color: 'red', count: 8, confidence: 'medium' }, { color: 'blue', count: 8 }, { color: 'yellow', count: 1 }, { color: 'purple', count: 1 }, { color: 'black', count: 3 }] },
    3: { piles: [{ color: 'blue', count: 11 }, { color: 'red', count: 5 }] },
  };
  window.__calls = [];
  const sample = Object.assign(async () => ({ text: '' }), {
    limits: async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 20000000, mediaTypes: ['image/jpeg', 'image/png'] } }),
    json: async (input, opts) => {
      const bmp = await createImageBitmap(opts.images[0]);
      const isLocate = String(input).includes('seat numbers 1-10');
      const seat = isLocate ? 0 : Number((String(input).match(/seat (\d+)\)/) || [0, 0])[1]);
      window.__calls.push({ kind: isLocate ? 'locate' : 'count', seat, w: bmp.width, h: bmp.height, tier: opts.modelTier });
      await new Promise((r) => setTimeout(r, 100));
      return isLocate ? LOCATE : COUNTS[seat];
    },
  });
  window.claude = { use: async (name) => (name === 'sample' ? sample : null) };
};

function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }
const flat = (s) => s.replace(/\s+/g, ' ');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(fakeClaude);
  await page.goto('file://' + pageFile);
  await page.waitForFunction(() => !document.querySelector('#in-pick').disabled);

  // 1. The example game (Oct 5) balances and settles.
  const check = flat(await page.locator('#check').innerText());
  assert(check.includes('账平了'), 'example game should balance: ' + check);
  const results = flat(await page.locator('#results').innerText());
  for (const v of ['+176.30', '+33.40', '+30.40', '−98.90', '−141.20']) assert(results.includes(v), `result ${v} missing: ${results}`);
  const transfers = await page.locator('.tr-list li').allInnerTexts();
  assert(transfers.length === 4, 'expected 4 transfers, got ' + transfers.length);
  console.log('ok  example game balances: ' + transfers.map(flat).join('; '));

  // 2. One extra yellow chip unbalances the books and the hint names yellow.
  await page.click('button[aria-label="姥爷 黄 加一"]');
  const off = flat(await page.locator('#check').innerText());
  assert(off.includes('多出 1,000') && off.includes('黄 1000 多数了 1 枚'), 'hint for +1 yellow: ' + off);
  await page.click('button[aria-label="姥爷 黄 减一"]');
  assert(flat(await page.locator('#check').innerText()).includes('账平了'), 'balanced again after -1');
  console.log('ok  +1 yellow flagged: "' + off.slice(0, 60) + '…"');

  // 3. Photo pipeline on a synthetic table photo.
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 2576; c.height = 1932;
    const g = c.getContext('2d');
    g.fillStyle = '#1f4f5a'; g.fillRect(0, 0, c.width, c.height);
    const dots = [['#f0c02e', 1370, 1500], ['#7a52d4', 1268, 1560], ['#2c2b2f', 1167, 1500], ['#3a85d6', 1450, 650], ['#dd3d48', 1860, 680], ['#3a85d6', 2150, 1150]];
    for (const [col, x, y] of dots) { g.fillStyle = col; g.beginPath(); g.arc(x, y, 34, 0, Math.PI * 2); g.fill(); }
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.setInputFiles('#in-pick', { name: 'table.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => document.querySelectorAll('#progress .state.done').length === 6, null, { timeout: 30000 });
  const calls = await page.evaluate(() => window.__calls);
  assert(calls.length === 6, 'expected 1 locate + 5 count calls, got ' + calls.length);
  assert(calls[0].kind === 'locate' && calls[0].tier === 'default', 'first call locates seats');
  for (const c of calls) assert(c.w * c.h <= 1.2e6, `image for ${c.kind} ${c.seat} is ${c.w}x${c.h}, over 1.2 MP`);
  for (const c of calls.slice(1)) assert(c.tier === 'complex', 'counting uses the complex tier');
  const after = flat(await page.locator('#check').innerText());
  assert(after.includes('多出 30') && after.includes('蓝 10 多数了 3 枚'), 'pipeline result should flag +30: ' + after);
  assert(after.includes('姥爷 蓝（把握低）'), 'low-confidence pile should be listed: ' + after);
  console.log('ok  photo pipeline: ' + calls.map((c) => `${c.kind}${c.seat || ''} ${c.w}x${c.h}`).join(', '));

  assert(errors.length === 0, 'page errors: ' + errors.join(' | '));
  await browser.close();
  console.log('all checks passed');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
