// Team Water — illustrative plant treatment diagram (ES module, no dependencies).
//
//   import { renderPlantDiagram, renderStaticSvgString, STAGE_KEYS } from '/js/diagram.js';
//   const d = renderPlantDiagram(el, { stages: plant.technology.stages, waterSource: plant.waterSource,
//                                      technologyRaw: plant.technology.raw, lang: 'en', animate: true });
//   d.destroy();
//
// Accuracy (docs/ARCHITECTURE.md §0, §5.3): only the stages passed in are drawn, plus an intake node
// labelled with the recorded water source. Nothing is inferred. With no stages, a neutral
// "treatment method not illustrated" box shows the recorded technology text instead.
// The art is inline SVG built from <symbol>/<use>; colours mirror /css/tokens.css (hex copies so the
// static markup also renders without CSS). renderStaticSvgString() touches no DOM, so it can run in
// Node for a no-JS fallback. Animation: CSS loops (flow, UV glow, tap drop) plus a one-off anime.js
// "hop" that is lazy-loaded only when motion is allowed and the diagram is on screen.

export const STAGE_KEYS = ['sediment', 'activated_carbon', 'ultrafiltration', 'reverse_osmosis', 'uv', 'chlorination', 'remineralization', 'storage', 'dispensing'];

export const STRINGS = {
  en: {
    title: 'Illustrative treatment diagram',
    note: 'Based on the recorded technology only. Other treatment stages, if any, are not recorded, and the order shown is illustrative.',
    shown: 'Shown',
    source: 'Water source',
    sourceTag: 'Source',
    recorded: 'Recorded',
    notProvided: 'Not provided',
    notIllustrated: 'Treatment method not illustrated',
    then: '→',
    stages: {
      sediment: 'Sediment filter',
      activated_carbon: 'Activated carbon',
      ultrafiltration: 'Ultrafiltration (UF)',
      reverse_osmosis: 'Reverse osmosis (RO)',
      uv: 'UV disinfection',
      chlorination: 'Chlorination',
      remineralization: 'Remineralisation',
      storage: 'Storage tank',
      dispensing: 'Dispensing taps',
    },
    sources: {
      tubewell: 'Groundwater (Tube Well)',
      canal: 'Surface Water (Canal Supply)',
      municipal: 'Mixed Municipal Supply',
      brackish: 'Brackish/Saline Groundwater',
      other: 'Other source',
      unknown: 'Not provided',
    },
  },
  ur: {
    title: 'صفائی کے عمل کا وضاحتی خاکہ',
    note: 'یہ خاکہ صرف درج شدہ ٹیکنالوجی پر مبنی ہے۔ اگر صفائی کے دیگر مراحل ہیں تو وہ درج نہیں، اور دکھائی گئی ترتیب محض وضاحتی ہے۔',
    shown: 'دکھایا گیا',
    source: 'پانی کا ذریعہ',
    sourceTag: 'ذریعہ',
    recorded: 'درج شدہ',
    notProvided: 'فراہم نہیں کیا گیا',
    notIllustrated: 'صفائی کا طریقہ خاکے میں شامل نہیں',
    then: '←',
    stages: {
      sediment: 'تلچھٹ فلٹر',
      activated_carbon: 'ایکٹیویٹڈ کاربن',
      ultrafiltration: 'الٹرا فلٹریشن (یو ایف)',
      reverse_osmosis: 'ریورس اوسموسس (آر او)',
      uv: 'یو وی جراثیم کشی',
      chlorination: 'کلورینیشن',
      remineralization: 'معدنیات کی بحالی',
      storage: 'ذخیرہ ٹینک',
      dispensing: 'پانی کے نل',
    },
    sources: {
      tubewell: 'زیرِ زمین پانی (ٹیوب ویل)',
      canal: 'سطحی پانی (نہری سپلائی)',
      municipal: 'مخلوط میونسپل سپلائی',
      brackish: 'کھارا / نمکین زیرِ زمین پانی',
      other: 'دیگر ذریعہ',
      unknown: 'فراہم نہیں کیا گیا',
    },
  },
};

// Exact recorded values that may be translated; anything else is shown verbatim.
const KNOWN_SOURCES = {
  'groundwater (tube well)': 'tubewell',
  'surface water (canal supply)': 'canal',
  'mixed municipal supply': 'municipal',
  'brackish/saline groundwater': 'brackish',
};

// Palette: hex copies of /css/tokens.css (+ a few derived shades, marked *).
const K = {
  n9: '#0a1a33', n8: '#0f2a4f', n7: '#163a6b',
  c6: '#2240c4', c5: '#3556e0', c1: '#e3e8fb', c4: '#6a83ec' /* * */,
  t7: '#0a6d80', t5: '#13a3bf', t2: '#a9d9e6', t1: '#d6eef4', t3: '#86c3d4' /* * */,
  pw: '#7f8ce0', fm: '#ffffff', s3: '#f3d08a', s1: '#faedcf', s4: '#dcb468' /* * */, rk: '#9a8f84',
  l1: '#d2d6db', l3: '#a5b5c1', l5: '#7e97a6', l7: '#4e6a7a', st: '#e8edf1' /* * steel */,
};

const SLOT = 92;          // node slot width (user units ≈ px at mobile scale 1)
const PAD_Y = 58;         // pad centre y within a row
const PIPE_DY = -6;       // connecting pipe height above pad centre
const SYM = [-46, -86, 92, 116]; // symbol box: x, y, w, h (origin = pad top centre)

// ───────────────────────── small SVG helpers ─────────────────────────
const r1 = (n) => Math.round(n * 10) / 10;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const iso = (u, v, z = 0) => [r1(u - v), r1((u + v) / 2 - z)];
const poly = (p, fill, x = '') => `<path d="M${p.map((q) => q.join(' ')).join('L')}Z" fill="${fill}"${x}/>`;

// Isometric box centred at screen offset (ox, oy); a/b = half extents along u/v; faces [top, left, right].
function box(ox, oy, a, b, h, z0, [top, left, right], x = '') {
  const P = (u, v, z) => { const q = iso(u, v, z); return [r1(q[0] + ox), r1(q[1] + oy)]; };
  return poly([P(-a, b, z0), P(a, b, z0), P(a, b, z0 + h), P(-a, b, z0 + h)], left, x)
    + poly([P(a, -b, z0), P(a, b, z0), P(a, b, z0 + h), P(a, -b, z0 + h)], right, x)
    + poly([P(-a, -b, z0 + h), P(a, -b, z0 + h), P(a, b, z0 + h), P(-a, b, z0 + h)], top, x);
}

// Vertical cylinder standing at screen (x, y); o.dome = dome colour, o.hl = highlight stripe.
function cyl(x, y, r, h, body, shade, top, o = {}) {
  const ry = r / 2, yt = r1(y - h), sx = r1(x + r * 0.38), sy = r1(y + ry * 0.92);
  let s = `<path d="M${r1(x - r)} ${yt}V${y}A${r} ${ry} 0 0 0 ${r1(x + r)} ${y}V${yt}Z" fill="${body}"/>`
    + `<path d="M${sx} ${yt}V${sy}A${r} ${ry} 0 0 0 ${r1(x + r)} ${y}V${yt}Z" fill="${shade}"/>`;
  if (o.hl !== false) s += `<path d="M${r1(x - r * 0.6)} ${r1(yt + ry + 1)}V${r1(y + ry * 0.5)}" stroke="#fff" stroke-opacity=".5" stroke-width="${r1(r * 0.18)}"/>`;
  if (o.dome) {
    const dh = r1(r * (o.domeH || 0.55));
    s += `<path d="M${r1(x - r)} ${yt}A${r} ${dh} 0 0 1 ${r1(x + r)} ${yt}A${r} ${ry} 0 0 1 ${r1(x - r)} ${yt}Z" fill="${o.dome}"/>`
      + `<ellipse cx="${r1(x - r * 0.35)}" cy="${r1(yt - dh * 0.45)}" rx="${r1(r * 0.28)}" ry="${r1(dh * 0.22)}" fill="#fff" opacity=".45"/>`;
  } else {
    s += `<ellipse cx="${x}" cy="${yt}" rx="${r}" ry="${ry}" fill="${top}"/>`;
  }
  return s;
}

// Horizontal cylinder from back point B to front point F along the iso u or v axis.
function hcyl(B, F, r, axis, body, shade, cap, capIn) {
  const k = axis === 'u' ? 1 : -1, tx = r1(0.707 * r * k), ty = r1(1.06 * r);
  const m = axis === 'u' ? '-1 .5 0 -1' : '1 .5 0 -1';
  const at = (p, dx, dy) => [r1(p[0] + dx), r1(p[1] + dy)];
  const band = (dx, dy, w, col, op = 1) => `<path d="M${at(B, dx, dy).join(' ')}L${at(F, dx, dy).join(' ')}" stroke="${col}" stroke-width="${w}"${op < 1 ? ` stroke-opacity="${op}"` : ''}/>`;
  return `<circle r="${r}" transform="matrix(${m} ${B[0]} ${B[1]})" fill="${shade}"/>`
    + poly([at(B, tx, -ty), at(F, tx, -ty), at(F, -tx, ty), at(B, -tx, ty)], shade)
    + band(r1(0.22 * r * k), r1(-0.5 * r), r1(r * 0.95), body)
    + band(r1(0.4 * r * k), r1(-0.92 * r), r1(r * 0.2), '#fff', 0.55)
    + `<circle r="${r}" transform="matrix(${m} ${F[0]} ${F[1]})" fill="${cap}"/>`
    + (capIn ? `<circle r="${r1(r * 0.6)}" transform="matrix(${m} ${F[0]} ${F[1]})" fill="${capIn}"/>` : '');
}

// Pipe with outline, water body and highlight. `flow` adds the animated dash overlay.
function pipe(d, o = {}) {
  const w = o.w || 5;
  let s = `<path d="${d}" stroke="${K.l7}" stroke-width="${w + 1.6}"/>`
    + `<path d="${d}" stroke="${o.body || K.t2}" stroke-width="${w}"/>`;
  if (o.flow) s += `<path class="twd-flow" d="${d}" stroke="${K.t5}" stroke-width="${r1(w * 0.45)}" stroke-dasharray="4 8"/>`;
  s += `<path d="${d}" stroke="#fff" stroke-opacity=".75" stroke-width="1" transform="translate(0 -${r1(w * 0.28)})"/>`;
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${s}</g>`;
}

// ───────────────────────── component art (local coords, origin = pad top centre) ─────────────────────────
const starfish = '<path transform="translate(22 6) scale(1 .62) rotate(-8)" d="M0-4.6L1.3-1.5 4.4-1.4 2-.6 2.7 3.7 0 1.4-2.7 3.7-2-.6-4.4-1.4-1.3-1.5Z" fill="#e2804f" stroke="#c4541f" stroke-width=".5" stroke-linejoin="round"/>';
const padArt = (top, left, right) => box(0, 0, 18, 18, 5, -5, [top, left, right])
  + '<path d="M-34.5 -.3L0 -17.5L34.5 -.3" fill="none" stroke="#fff" stroke-width="1.3" stroke-linejoin="round" opacity=".9"/>'
  + '<g fill="#fff" opacity=".8"><circle cx="-20" cy="4" r="1.2"/><circle cx="-15" cy="7.5" r=".8"/><circle cx="21" cy="5" r="1"/></g>';

const riser = (x0, y0, top, x1) => pipe(`M${x0} ${y0}V${top}H${x1}V${PIPE_DY}`, { w: 4 });

const ART = {
  pad: () => padArt('#e2f2f7', K.t2, K.t3),
  padSand: () => padArt(K.s1, K.s3, K.s4) + starfish,
  padSlate: () => padArt('#e9edf0', K.l1, K.l3),
  ghostPad: () => poly([[0, -18], [36, 0], [0, 18], [-36, 0]], 'none', ` stroke="${K.l5}" stroke-width="1.2" stroke-dasharray="3 3"`),

  // Intakes — the icon follows the recorded water source; the label always shows the recorded text.
  tubewell: () => '<path d="M0 1V13" stroke="#0a6d80" stroke-width="1.3" stroke-dasharray="2 2"/>'
    + '<ellipse cx="0" cy="14" rx="9" ry="3" fill="#a9d9e6"/><path d="M-6 14q3 -1.6 6 0t6 0" stroke="#fff" fill="none" stroke-width=".9"/>'
    + box(0, 0, 8, 8, 3, 0, [K.l1, K.l3, K.l5])
    + cyl(0, -3, 5, 13, K.l3, K.l5, K.n8, { hl: true })
    + box(-15, -2, 6, 5, 11, 0, [K.c5, K.c6, K.n7]) + '<circle cx="-18" cy="-8" r="1.6" fill="#fff" opacity=".85"/>'
    + riser(0, -14, -30, 16),

  brackish: () => '<path d="M0 1V13" stroke="#4e6a7a" stroke-width="1.3" stroke-dasharray="2 2"/>'
    + '<ellipse cx="0" cy="14" rx="9" ry="3" fill="#a5b5c1"/>'
    + box(0, 0, 8, 8, 3, 0, [K.l1, K.l3, K.l5])
    + cyl(0, -3, 5, 13, K.t2, K.t3, K.l7)
    + [[-18, 2], [-13, 6], [-22, 7], [-7, 11]].map(([x, y], i) => box(x, y, i % 2 ? 1.6 : 2.2, i % 2 ? 1.6 : 2.2, i % 2 ? 2 : 3, 0, ['#fff', K.l1, K.l3])).join('')
    + riser(0, -16, -30, 16),

  canal: () => {
    const P = (u, v) => iso(u, v, 0);
    return poly([P(-8, -18), P(8, -18), P(8, 18), P(-8, 18)], K.t5)
      + poly([P(-5, -18), P(5, -18), P(5, 18), P(-5, 18)], '#5fc3d8')
      + '<path d="M3 -8q3 -1.5 6 0t6 0M-13 4q3 -1.5 6 0t6 0M-5 -1q2.5 -1.2 5 0" stroke="#fff" stroke-width="1" fill="none" stroke-linecap="round"/>'
      + cyl(-2, 1, 4.5, 7, K.c5, K.c6, K.n7, { hl: false })
      + '<path d="M-5.5 -3.5h7M-5.5 -1h7" stroke="#fff" stroke-width=".7" opacity=".7"/>'
      + riser(-2, -6, -30, 16);
  },

  municipal: () => {
    const B = iso(0, -17, 6), F = iso(0, 17, 6);
    return hcyl(B, F, 6, 'v', K.c5, K.c6, K.n7, K.c4)
      + `<circle r="7.2" transform="matrix(1 .5 0 -1 ${iso(0, 4, 6).join(' ')})" fill="${K.l3}"/>`
      + hcyl(iso(0, 4.6, 6), iso(0, 6, 6), 6.2, 'v', K.l3, K.l5, K.l5, null)
      + pipe(`M0 -8V-30H16V${PIPE_DY}`, { w: 4 })
      + '<g transform="translate(0 -24)"><ellipse rx="8" ry="4" fill="none" stroke="#0a6d80" stroke-width="2"/><path d="M-8 0H8M0 -4V4" stroke="#0a6d80" stroke-width="1.2"/><ellipse rx="1.6" ry=".8" fill="#0a6d80"/></g>';
  },

  other: () => box(0, 0, 7, 7, 3, 0, [K.l1, K.l3, K.l5])
    + cyl(0, -3, 4, 8, K.l3, K.l5, K.n8) + riser(0, -10, -26, 16)
    + '<g transform="translate(0 -26)"><ellipse rx="6" ry="3" fill="none" stroke="#4e6a7a" stroke-width="1.6"/><path d="M-6 0H6" stroke="#4e6a7a" stroke-width="1"/></g>',

  ghost: () => {
    const P = (u, v, z) => iso(u, v, z), a = 11;
    const e = (p, q) => `M${P(...p).join(' ')}L${P(...q).join(' ')}`;
    const back = [e([-a, -a, 0], [a, -a, 0]), e([-a, -a, 0], [-a, a, 0]), e([-a, -a, 0], [-a, -a, 26])].join('');
    const front = [e([a, -a, 0], [a, a, 0]), e([-a, a, 0], [a, a, 0]), e([a, a, 0], [a, a, 26]), e([a, -a, 0], [a, -a, 26]), e([-a, a, 0], [-a, a, 26]),
      e([-a, -a, 26], [a, -a, 26]), e([a, -a, 26], [a, a, 26]), e([a, a, 26], [-a, a, 26]), e([-a, a, 26], [-a, -a, 26])].join('');
    return poly([P(-a, -a, 26), P(a, -a, 26), P(a, a, 26), P(-a, a, 26)], '#fff', ' opacity=".7"')
      + `<path d="${back}" stroke="${K.l3}" stroke-width="1.1" stroke-dasharray="2.5 2.5" fill="none"/>`
      + `<path d="${front}" stroke="${K.l5}" stroke-width="1.3" stroke-dasharray="3 2.5" fill="none" stroke-linecap="round"/>`;
  },

  // Treatment stages
  sediment: () => cyl(0, 0, 14, 4, K.l3, K.l5, K.l1, { hl: false })
    + cyl(0, -4, 12, 36, '#f4f7f9', K.l1, null, { dome: K.l3 })
    + '<rect x="-8" y="-33" width="9" height="26" rx="3" fill="#fff" stroke="#a5b5c1" stroke-width=".8"/>'
    + '<rect x="-7" y="-24" width="7" height="6" fill="#faedcf"/><rect x="-7" y="-18" width="7" height="5" fill="#f3d08a"/><rect x="-7" y="-13" width="7" height="5" rx="1.5" fill="#9a8f84"/>'
    + '<g fill="#fff" opacity=".7"><circle cx="-5" cy="-11" r=".8"/><circle cx="-2.5" cy="-9.5" r=".7"/></g>',

  activated_carbon: () => cyl(0, 0, 13.5, 4, K.l3, K.l5, K.l1, { hl: false })
    + cyl(0, -4, 11.5, 40, K.n7, K.n9, null, { dome: K.n8 })
    + '<rect x="-7.5" y="-36" width="8.5" height="28" rx="3" fill="#0a1a33" stroke="#4e6a7a" stroke-width=".8"/>'
    + '<g fill="#4e6a7a">' + [[-5, -31], [-2, -28], [-5.5, -25], [-2.5, -22], [-5, -19], [-2, -16], [-5.5, -13], [-2.5, -11]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.3"/>`).join('') + '</g>'
    + `<path d="M-11.5 -22h23" stroke="${K.t5}" stroke-width="1.6" opacity=".9"/>`,

  cart: () => cyl(0, 0, 5, 30, '#fbfcfd', K.l1, null, { dome: K.c5, domeH: 0.5 }) + cyl(0, -24, 5, 3, K.c5, K.c6, K.c4, { hl: false }),
  ultrafiltration: () => box(0, 0, 20, 6, 4, 0, [K.l1, K.l3, K.l5])
    + [-13, 0, 13].map((u) => { const [x, y] = iso(u, 0, 4); return useSym('cart', x, y); }).join('')
    + hcyl(iso(-16, 0, 36.5), iso(16, 0, 36.5), 2.6, 'u', K.c5, K.c6, K.n7, null),

  tube: () => hcyl(iso(-18, 0, 0), iso(18, 0, 0), 5.2, 'u', K.c5, K.c6, '#fff', K.l1),
  reverse_osmosis: () => {
    const post = (u, v) => { const a = iso(u, v, 0), b = iso(u, v, 40); return `<path d="M${a.join(' ')}L${b.join(' ')}" stroke="${K.l7}" stroke-width="2.2" stroke-linecap="round"/>`; };
    return box(0, 0, 19, 7, 3, 0, [K.l3, K.l5, K.l7])
      + post(-12, -5) + post(12, -5)
      + [9, 20, 31].map((z) => { const [x, y] = iso(0, 0, z + 3); return useSym('tube', x, y); }).join('')
      + post(-12, 5) + post(12, 5)
      + `<circle cx="${iso(18, 0, 42)[0]}" cy="${iso(18, 0, 42)[1]}" r="2.2" fill="${K.t5}" stroke="#fff" stroke-width=".8"/>`;
  },

  uv: () => {
    const leg = (u) => box(...iso(u, 0, 0), 2, 2, 8, 0, [K.l3, K.l5, K.l7]);
    const bx = iso(-6, -15, 0), cb = iso(-6, -15, 12), ch = iso(-6, 0, 21);
    return box(bx[0], bx[1], 5, 4, 12, 0, [K.c5, K.c6, K.n7])
      + `<path d="M${cb[0]} ${cb[1]}C${cb[0]} ${cb[1] - 8} ${ch[0]} ${ch[1] - 10} ${ch[0]} ${ch[1]}" stroke="${K.l7}" stroke-width="1.4" fill="none"/>`
      + leg(-11) + leg(11)
      + hcyl(iso(-17, 0, 15), iso(17, 0, 15), 7.5, 'u', K.st, K.l3, K.l5, K.l3)
      + `<path d="M${iso(-14, 0, 21).join(' ')}L${iso(14, 0, 21).join(' ')}" stroke="#7fe9ff" stroke-width="3.2" stroke-linecap="round"/>`
      + `<path d="M${iso(-14, 0, 21).join(' ')}L${iso(14, 0, 21).join(' ')}" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>`;
  },

  chlorination: () => cyl(-9, 3, 9.5, 22, '#fbfcfd', K.l1, null, { dome: K.c1, domeH: 0.35 })
    + '<rect x="-15" y="-11" width="6" height="12" rx="2" fill="#d6eef4" stroke="#a9d9e6" stroke-width=".8"/><rect x="-15" y="-5" width="6" height="6" rx="2" fill="#a9d9e6"/>'
    + cyl(-9, -21, 3, 3, K.c5, K.c6, K.c4, { hl: false })
    + box(12, -3, 6, 5, 9, 0, [K.c5, K.c6, K.n7])
    + `<circle cx="${iso(18, -3, 5)[0] - 6}" cy="${iso(18, -3, 5)[1] - 3}" r="1.8" fill="#fff"/>`
    + `<path d="M-9 -23C-6 -34 8 -32 11 -15" stroke="${K.t7}" stroke-width="1.3" fill="none"/>`
    + '<path d="M14 -24c1.6 2.4 2.6 3.6 2.6 5a2.6 2.6 0 0 1 -5.2 0c0 -1.4 1 -2.6 2.6 -5z" fill="#13a3bf"/>',

  remineralization: () => cyl(0, 0, 13, 4, K.l3, K.l5, K.l1, { hl: false })
    + cyl(0, -4, 11, 30, K.s1, K.s3, null, { dome: K.s4 })
    + '<rect x="-7.5" y="-28" width="8.5" height="20" rx="3" fill="#fff" stroke="#dcb468" stroke-width=".8"/>'
    + [[-5, -11, K.rk], [-2, -12, K.pw], [-5.5, -15, K.s3], [-2.3, -16, K.t5], [-5, -19.5, K.pw], [-2, -21, K.rk], [-5, -24, K.t2]]
      .map(([x, y, c]) => `<circle cx="${x}" cy="${y}" r="1.7" fill="${c}"/>`).join(''),

  storage: () => cyl(0, 2, 22, 28, '#fbfdfe', '#c9e4ec', null, { hl: false })
    + `<path d="M-22 -14V-10A22 11 0 0 0 22 -10V-14A22 11 0 0 1 -22 -14Z" fill="${K.t5}"/>`
    + `<path d="M8.4 -4.6V-.8A22 11 0 0 0 22 -10V-14A22 11 0 0 1 8.4 -4.6Z" fill="${K.t7}"/>`
    + '<path d="M-22 -26L0 -38L22 -26A22 11 0 0 1 -22 -26Z" fill="#13a3bf"/><path d="M0 -38L22 -26A22 11 0 0 1 0 -15Z" fill="#0a6d80"/>'
    + cyl(0, -35, 4, 3, K.l1, K.l3, K.l3, { hl: false })
    + '<rect x="-15.5" y="-22" width="3" height="21" rx="1.5" fill="#d6eef4" stroke="#a9d9e6" stroke-width=".6"/><rect x="-15.5" y="-12" width="3" height="11" rx="1.5" fill="#13a3bf"/>'
    + '<path d="M13 -22V6M17 -24V4M13 -17H17M13 -11H17M13 -5H17M13 1H17" stroke="#7e97a6" stroke-width="1" fill="none"/>'
    + '<path d="M-17 -21V1" stroke="#fff" stroke-width="2.2" opacity=".6"/>',

  tap: () => pipe('M0 0l4.5 2.2V6', { w: 2.4, body: K.l1 }),
  dispensing: () => {
    const a = 10, b = 9, t1 = iso(a, -3.5, 15), t2 = iso(a, 4, 15);
    return box(iso(a + 5, 0, 0)[0], iso(a + 5, 0, 0)[1], 4, 9, 2, 0, [K.l1, K.l3, K.l5])
      + box(0, 0, a, b, 27, 0, [K.c5, K.c6, K.n7])
      + poly([iso(-7, b, 23), iso(7, b, 23), iso(7, b, 17), iso(-7, b, 17)], '#fff', ' opacity=".9"')
      + `<path d="M${iso(0, b, 22.2).join(' ')}c1.2 1.8 2 2.8 2 3.8a2 2 0 0 1 -4 0c0 -1 .8 -2 2 -3.8z" fill="${K.t5}"/>`
      + useSym('tap', t1[0], t1[1]) + useSym('tap', t2[0], t2[1]);
  },
};

// Symbol boxes. Stage/intake units share SYM; sub-components have their own.
const SUB = { cart: [-7, -42, 14, 48], tube: [-24, -16, 48, 32], tap: [-3, -3, 12, 12] };
let SP = 'twd'; // id prefix of the SVG being built (set per render)
function useSym(id, x, y, extra = '') {
  const b = SUB[id] || SYM;
  return `<use href="#${SP}-${id}" x="${r1(x + b[0])}" y="${r1(y + b[1])}" width="${b[2]}" height="${b[3]}"${extra}/>`;
}
function symbol(id) {
  const b = SUB[id] || SYM;
  return `<symbol id="${SP}-${id}" viewBox="${b.join(' ')}" overflow="visible">${ART[id]()}</symbol>`;
}
const DEPS = { ultrafiltration: ['cart'], reverse_osmosis: ['tube'], dispensing: ['tap'] };

// ───────────────────────── text helpers ─────────────────────────
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

function wrap(text, max, maxLines) {
  const str = String(text).trim();
  if (str.length <= max) return [str];
  const par = str.indexOf(' ('); // prefer "Groundwater" / "(Tube Well)"
  if (maxLines > 1 && par > 0 && par <= max && str.length - par - 1 <= max) return [str.slice(0, par), str.slice(par + 1)];
  const words = str.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let w of words) {
    while (w.length > max) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, max - 1) + '-'); w = w.slice(max - 1); }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = (last.length >= max ? last.slice(0, max - 1) : last) + '…';
  }
  return lines;
}

export function sourceKind(source) {
  const t = String(source || '').trim().toLowerCase();
  if (!t) return 'unknown';
  if (/brackish|saline|salt|کھار|نمکین/.test(t)) return 'brackish';
  if (/canal|surface|river|stream|نہر/.test(t)) return 'canal';
  if (/municipal|mains|wasa|city supply|میونسپل/.test(t)) return 'municipal';
  if (/tube ?well|ground ?water|bore|well|زیر ?زمین|ٹیوب/.test(t)) return 'tubewell';
  return 'other';
}

function normalizeStages(stages) {
  const set = new Set(Array.isArray(stages) ? stages.map((s) => String(s).trim()) : []);
  return STAGE_KEYS.filter((k) => set.has(k)); // canonical, deduped, unknown keys dropped (never invented)
}

// ───────────────────────── model ─────────────────────────
function model(opts = {}) {
  const lang = opts.lang === 'ur' ? 'ur' : 'en';
  const S = STRINGS[lang];
  const stages = normalizeStages(opts.stages);
  const rawSource = opts.waterSource == null ? '' : String(opts.waterSource).trim();
  const kind = sourceKind(rawSource);
  const known = KNOWN_SOURCES[rawSource.toLowerCase()];
  const sourceLabel = !rawSource ? S.notProvided : lang === 'ur' && known ? S.sources[known] : rawSource;
  const rawTech = opts.technologyRaw == null ? '' : String(opts.technologyRaw).trim();
  const techText = rawTech || S.notProvided;
  const art = kind === 'unknown' ? 'other' : kind;
  const nodes = [{ key: 'intake', art, pad: kind === 'municipal' ? 'padSlate' : 'padSand', label: sourceLabel, tag: S.sourceTag }];
  if (stages.length) for (const k of stages) nodes.push({ key: k, art: k, pad: 'pad', label: S.stages[k] });
  else nodes.push({ key: 'none', art: 'ghost', pad: 'ghostPad', label: S.notIllustrated, sub: [S.recorded, techText], wide: true });

  const srcWords = `${S.source}: ${sourceLabel}` + (lang === 'ur' && known && rawSource ? ` (${S.recorded}: ${rawSource})` : '');
  const stepWords = stages.length ? stages.map((k) => S.stages[k]) : [`${S.notIllustrated} (${S.recorded}: ${techText})`];
  return { lang, S, stages, nodes, rawSource, known, techText, srcWords, stepWords, rtl: lang === 'ur' };
}

// ───────────────────────── layout + SVG ─────────────────────────
let seq = 0;

function buildSvg(m, prefix) {
  SP = prefix;
  const n = m.nodes.length;
  const perRow = n <= 4 ? n : Math.ceil(n / Math.ceil(n / 4));
  const rows = Math.ceil(n / perRow);
  const ur = m.rtl;
  const rowH = ur ? 142 : 124;
  const side = rows > 1 ? 24 : 8;
  const widths = m.nodes.map((nd) => (nd.wide ? SLOT * 2.1 : SLOT));
  const contentW = rows > 1 ? perRow * SLOT : widths.reduce((a, b) => a + b, 0);
  const W = Math.max(contentW + side * 2, 310);
  const H = rows * rowH + 2;
  const x0 = (W - contentW) / 2;

  // positions
  const pos = [];
  if (rows === 1) {
    let acc = 0;
    const order = m.nodes.map((_, i) => i);
    const xs = [];
    for (const i of order) { xs[i] = acc + widths[i] / 2; acc += widths[i]; }
    for (let i = 0; i < n; i++) pos.push({ x: r1(x0 + (ur ? contentW - xs[i] : xs[i])), y: PAD_Y, row: 0, dir: ur ? -1 : 1 });
  } else {
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / perRow);
      let col = i % perRow;
      let dir = 1;
      if (row % 2) { col = perRow - 1 - col; dir = -1; }
      if (ur) { col = perRow - 1 - col; dir = -dir; }
      pos.push({ x: r1(x0 + (col + 0.5) * SLOT), y: row * rowH + PAD_Y, row, dir });
    }
  }

  // defs: only the symbols this diagram needs
  const ids = new Set();
  for (const nd of m.nodes) { ids.add(nd.pad); ids.add(nd.art); for (const d of DEPS[nd.art] || []) ids.add(d); }
  const glowId = `${SP}-glow`;
  let defs = [...ids].map(symbol).join('');
  if (ids.has('uv')) defs += `<radialGradient id="${glowId}"><stop offset="0" stop-color="#c9f7ff" stop-opacity=".95"/><stop offset=".5" stop-color="#5fd4ea" stop-opacity=".45"/><stop offset="1" stop-color="#7f8ce0" stop-opacity="0"/></radialGradient>`;

  // pads
  const pads = m.nodes.map((nd, i) => `<g transform="translate(${pos[i].x} ${pos[i].y})">${useSym(nd.pad, 0, 0)}</g>`).join('');

  // pipes + direction chevrons
  let pipes = '';
  let marks = '';
  const chevron = (x, y, ang) => `<g transform="translate(${r1(x)} ${r1(y)}) rotate(${ang})"><circle r="5.2" fill="#fff" stroke="${K.l3}" stroke-width=".8"/><path d="M-1.6 -2.6L1.4 0L-1.6 2.6" fill="none" stroke="${K.c6}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  for (let i = 0; i < n - 1; i++) {
    const a = pos[i], b = pos[i + 1];
    const ya = a.y + PIPE_DY, yb = b.y + PIPE_DY;
    const unknown = m.nodes[i + 1].key === 'none';
    if (a.row === b.row) {
      const d = `M${a.x} ${ya}H${b.x}`;
      pipes += unknown
        ? `<path d="${d}" stroke="${K.l5}" stroke-width="3" stroke-dasharray="4 4" fill="none"/>`
        : pipe(d, { flow: true });
      marks += chevron((a.x + b.x) / 2, ya, a.dir > 0 ? 0 : 180);
    } else {
      const xo = a.x + a.dir * (SLOT / 2 + side * 0.45);
      const d = `M${a.x} ${ya}H${r1(xo)}V${yb}H${b.x}`;
      pipes += pipe(d, { flow: true });
      marks += chevron(xo, (ya + yb) / 2 - 10, 90);
    }
  }

  // units (+ inline animated overlays)
  let units = '';
  m.nodes.forEach((nd, i) => {
    const p = pos[i];
    const tf = `translate(${p.x} ${p.y})${p.dir < 0 ? ' scale(-1 1)' : ''}`;
    let pre = '', post = '';
    if (nd.art === 'uv') pre = `<ellipse class="twd-glow" cx="0" cy="-16" rx="30" ry="21" fill="url(#${glowId})"/>`;
    if (nd.art === 'dispensing') {
      const t1 = iso(10, -3.5, 15), t2 = iso(10, 4, 15);
      post = [t1, t2].map((t, j) => `<path class="twd-drop${j ? ' twd-drop2' : ''}" d="M${r1(t[0] + 4.5)} ${r1(t[1] + 7)}c1.1 1.6 1.7 2.5 1.7 3.3a1.7 1.7 0 0 1 -3.4 0c0 -.8 .6 -1.7 1.7 -3.3z" fill="${K.t5}"/>`).join('');
    }
    units += `<g class="twd-u"><g transform="${tf}">${pre}${useSym(nd.art, 0, 0)}${post}</g></g>`;
  });

  // labels (one <text> per line so Latin lines keep LTR order inside Urdu diagrams)
  const fs = ur ? 11 : 10.5, lh = ur ? 19 : 12.5, max = ur ? 22 : 17;
  let labels = '';
  m.nodes.forEach((nd, i) => {
    const p = pos[i];
    const wmax = nd.wide ? Math.round(max * 2) : max;
    let y = p.y + (ur ? 37 : 35);
    const line = (txt, cls, size, weight, fill, gap = lh) => {
      const lat = !RTL_CHARS.test(txt);
      const out = `<text x="${p.x}" y="${r1(y)}" class="${cls}${lat ? ' twd-lat' : ''}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''} fill="${fill}" text-anchor="middle" direction="${lat ? 'ltr' : 'rtl'}">${esc(txt)}</text>`;
      y += lat && ur ? 14 : gap;
      return out;
    };
    if (nd.tag) labels += line(ur ? nd.tag : nd.tag.toUpperCase(), 'twd-tag', ur ? 10 : 8, 700, K.t7, ur ? 18 : 12);
    for (const t of wrap(nd.label, wmax, nd.wide ? 1 : 2)) labels += line(t, 'twd-lbl', fs, 600, K.n7);
    if (nd.sub) {
      const [k, v] = nd.sub;
      const subLines = ur ? [`${k}:`, ...wrap(v, wmax, 1)] : wrap(`${k}: ${v}`, wmax, 2);
      for (const t of subLines) labels += line(t, 'twd-sub', ur ? 10.5 : 9.5, 400, K.l7, ur ? 18 : 11.5);
    }
  });

  const aria = `${m.S.title}. ${m.srcWords} ${m.S.then} ${m.stepWords.join(` ${m.S.then} `)}`;
  const maxW = Math.round(W * 1.12);
  return `<svg class="twd-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r1(W)} ${H}" role="img" aria-label="${esc(aria)}" `
    + `style="display:block;width:100%;height:auto;max-width:${maxW}px;margin:0 auto" font-family="Inter, system-ui, sans-serif" data-rows="${rows}">`
    + `<defs>${defs}</defs><g class="twd-pads">${pads}</g><g class="twd-pipes">${pipes}${marks}</g><g class="twd-units">${units}</g><g class="twd-labels">${labels}</g></svg>`;
}

function figureHtml(m, prefix) {
  const S = m.S;
  const sep = ` <span aria-hidden="true">${S.then}</span> `;
  const bdi = (s) => `<bdi>${esc(s)}</bdi>`;
  const src = `${esc(S.source)}: ${bdi(m.nodes[0].label)}` + (m.rtl && m.known && m.rawSource ? ` (${esc(S.recorded)}: <bdi dir="ltr">${esc(m.rawSource)}</bdi>)` : '');
  const steps = m.stages.length
    ? m.stages.map((k) => esc(S.stages[k])).join(sep)
    : `${esc(S.notIllustrated)} (${esc(S.recorded)}: ${bdi(m.techText)})`;
  return `<figure class="twd twd--${m.stages.length ? 'stages' : 'none'}" lang="${m.lang}" dir="${m.rtl ? 'rtl' : 'ltr'}" data-stages="${esc(m.stages.join(' '))}">`
    + `<div class="twd-art">${buildSvg(m, prefix)}</div>`
    + '<figcaption class="twd-cap">'
    + `<span class="twd-title">${esc(S.title)}</span>`
    + `<span class="twd-steps"><span class="twd-shown">${esc(S.shown)}:</span> ${src}${sep}${steps}</span>`
    + `<span class="twd-note">${esc(S.note)}</span>`
    + '</figcaption></figure>';
}

const nextPrefix = () => `twd${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Static markup (no animation, no DOM access). Returns a complete `<figure>` string; pass
 *  `{ svgOnly: true }` for just the `<svg>`. Safe to call in Node for a no-JS fallback. */
export function renderStaticSvgString(opts = {}) {
  const m = model(opts);
  const prefix = opts.idPrefix ? String(opts.idPrefix).replace(/[^\w-]/g, '') : nextPrefix();
  return opts.svgOnly ? buildSvg(m, prefix) : figureHtml(m, prefix);
}

// ───────────────────────── browser rendering ─────────────────────────
const CSS_HREF = '/css/diagram.css';
const ANIME_URL = '/vendor/animejs/anime.esm.min.js';
let animeP = null;
const live = new WeakMap();

function ensureStylesheet() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('twd-css') || document.querySelector(`link[rel="stylesheet"][href$="${CSS_HREF}"]`)) return;
  const link = document.createElement('link');
  link.id = 'twd-css';
  link.rel = 'stylesheet';
  link.href = CSS_HREF;
  document.head.appendChild(link);
}

function motionAllowed(animate) {
  if (animate === false) return false;
  try { return !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return true; }
}

export function renderPlantDiagram(container, { stages = [], waterSource = null, technologyRaw = null, lang = 'en', animate = true } = {}) {
  if (!container) throw new TypeError('renderPlantDiagram: container is required');
  ensureStylesheet();
  const prev = live.get(container);
  if (prev) prev.destroy();

  const tpl = document.createElement('template');
  tpl.innerHTML = renderStaticSvgString({ stages, waterSource, technologyRaw, lang });
  const fig = tpl.content.firstElementChild;
  container.appendChild(fig);

  let io = null, anim = null, dead = false, hopped = false;
  if (motionAllowed(animate)) {
    fig.classList.add('twd--anim');
    const hop = () => {
      if (hopped) return;
      hopped = true;
      animeP = animeP || import(ANIME_URL).catch(() => null);
      animeP.then((lib) => {
        if (!lib || dead) return;
        anim = lib.animate(fig.querySelectorAll('.twd-u'), {
          translateY: [{ to: -3, duration: 240, ease: 'outQuad' }, { to: 0, duration: 520, ease: 'outBounce' }],
          delay: lib.stagger(160, { start: 150 }),
        });
      });
    };
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) { fig.classList.toggle('twd--play', e.isIntersecting); if (e.isIntersecting) hop(); }
      }, { rootMargin: '40px' });
      io.observe(fig);
    } else {
      fig.classList.add('twd--play');
    }
  }

  const handle = {
    element: fig,
    destroy() {
      if (dead) return;
      dead = true;
      if (io) io.disconnect();
      if (anim) { try { anim.revert(); } catch { /* already finished */ } }
      fig.classList.remove('twd--anim', 'twd--play');
      fig.remove();
      if (live.get(container) === handle) live.delete(container);
    },
  };
  live.set(container, handle);
  return handle;
}

/** Declarative mount for static pages: <div data-tw-diagram='{"stages":["uv"],"waterSource":"…"}'></div>.
 *  Runs automatically when this module is imported as /js/diagram.js?autorender. */
export function autoRender(root = document) {
  const out = [];
  for (const el of root.querySelectorAll('[data-tw-diagram]')) {
    let opts = {};
    try { opts = JSON.parse(el.getAttribute('data-tw-diagram') || '{}'); } catch { /* bad JSON → defaults */ }
    out.push(renderPlantDiagram(el, opts));
  }
  return out;
}

if (typeof document !== 'undefined' && /[?&]autorender\b/.test(import.meta.url)) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => autoRender(), { once: true });
  else autoRender();
}
