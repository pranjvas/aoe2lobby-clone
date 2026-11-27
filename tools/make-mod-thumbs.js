// Draws the /mods page's thumbnails: one SVG scene per mod in pv-mods.json (mod-thumbs/<id>.svg). Each is a landscape in
// the mod's own colours, with emblems for what the mod changes, a title banner and a corner ribbon for its variant.
// Original vector art (no game assets). Run after adding or changing a mod: node tools/make-mod-thumbs.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'mod-thumbs');
const W = 384, H = 216;

// sky top/bottom, sun, far hills, near hills, field, furrows; night: a moon instead of a sun
const PALETTES = {
    harvest: { sky: ['#f3b65e', '#d8673a'], sun: '#ffeab0', far: '#8a4a2f', near: '#5a3720', field: '#d1a72e', furrow: '#8f6f12' },
    dusk: { sky: ['#5f4596', '#e27a69'], sun: '#ffd9a0', far: '#4b3670', near: '#2c2145', field: '#b98d3c', furrow: '#7a5a20' },
    meadow: { sky: ['#8fcdf0', '#eaf4c9'], sun: '#fff6c4', far: '#6fa45a', near: '#3d7838', field: '#cdb64c', furrow: '#8c7a26' },
    summer: { sky: ['#6fbcef', '#f7e2a0'], sun: '#fff1a8', far: '#7aa64f', near: '#4b7f30', field: '#e3bb3c', furrow: '#9c7d1c' },
    war: { sky: ['#371b22', '#b8432f'], sun: '#ffb27a', far: '#5a2a2a', near: '#2a1316', field: '#9c7c30', furrow: '#5e4718' },
    warNight: { sky: ['#121831', '#7a2e3a'], sun: '#f3e3c0', far: '#2e2540', near: '#17132a', field: '#7c6a3a', furrow: '#4a3e20', night: true },
    forest: { sky: ['#b7e0c2', '#f3e6b6'], sun: '#fff4c0', far: '#4f7f4a', near: '#2a582c', field: '#bb9c3d', furrow: '#7a6224' },
    forestDusk: { sky: ['#2c4838', '#d98b48'], sun: '#ffd28a', far: '#2f4a32', near: '#1a2d1d', field: '#9c8034', furrow: '#5f4c1d' },
    ocean: { sky: ['#0e2850', '#4183ba'], sun: '#ffe6a3', far: '#1e4a78', near: '#11304f', field: '#c9a340', furrow: '#7f6522' },
    oceanDusk: { sky: ['#1a1e49', '#da865a'], sun: '#ffd79a', far: '#28305e', near: '#141938', field: '#b28c3b', furrow: '#6c5420' },
    stone: { sky: ['#8aa0b3', '#dce2e6'], sun: '#ffffff', far: '#6e7b86', near: '#48525a', field: '#bba55b', furrow: '#7d6c34' },
    stoneDawn: { sky: ['#978bb3', '#f2c99e'], sun: '#fff0d0', far: '#77708a', near: '#4c485c', field: '#c6aa5b', furrow: '#86703a' },
    trade: { sky: ['#1c6c70', '#f1c47b'], sun: '#fff0b8', far: '#2f6a5e', near: '#1c4840', field: '#d4af46', furrow: '#8e7420' },
    harvestNight: { sky: ['#0d1330', '#3c4080'], sun: '#f1ead0', far: '#2a2d55', near: '#151732', field: '#8c7941', furrow: '#504522', night: true }
};

// Each mod: palette, emblems (left to right), title on the banner, ribbon text
const SCENES = {
    582909: { palette: 'harvest', emblems: ['house', 'farm2', 'cart'], title: 'Big Houses · 2×2 Farms · Flying Carts', ribbon: 'UPD 1' },
    562008: { palette: 'dusk', emblems: ['house', 'farm2', 'cart'], title: 'Big Houses · 2×2 Farms · Flying Carts', ribbon: 'DESYNC FIX' },
    550210: { palette: 'meadow', emblems: ['house', 'farm1', 'cart'], title: 'Big Houses · Small Farms · Flying Carts', ribbon: 'CLASSIC' },
    550514: { palette: 'summer', emblems: ['house', 'wheat', 'cart'], title: 'Big Houses · Small Farms · Flying Carts', ribbon: '+20% FARMING' },
    594058: { palette: 'war', emblems: ['farm2', 'cart', 'swords'], title: '2×2 Farms · Military Builds', ribbon: 'MILITARY' },
    604261: { palette: 'warNight', emblems: ['farm2', 'cart', 'swords'], title: '2×2 Farms · Military Builds', ribbon: 'WALK-THROUGH' },
    594059: { palette: 'forest', emblems: ['tree', 'farm2', 'swords'], title: '2× Wood · 2×2 Farms · Military', ribbon: '2× WOOD' },
    604260: { palette: 'forestDusk', emblems: ['tree', 'farm2', 'swords'], title: '2× Wood · 2×2 Farms · Military', ribbon: 'FIX' },
    604063: { palette: 'ocean', emblems: ['caravel', 'tree', 'swords'], title: 'Portuguese · 2× Wood · Military', ribbon: 'PORTUGUESE' },
    604262: { palette: 'oceanDusk', emblems: ['caravel', 'tree', 'swords'], title: 'Portuguese · 2× Wood · Military', ribbon: 'V2' },
    583147: { palette: 'stone', emblems: ['wall', 'feitoria', 'farm2'], title: 'Cheap Walls · Feitoria · 2×2 Farms', ribbon: 'CHEAP WALLS' },
    583148: { palette: 'trade', emblems: ['feitoria', 'farm2'], title: 'Feitoria 10 Pop · 2×2 Farms', ribbon: 'FEITORIA' },
    583144: { palette: 'stoneDawn', emblems: ['wall', 'farm2'], title: 'Cheap Walls · 2×2 Farms', ribbon: 'CHEAP WALLS' },
    582907: { palette: 'harvestNight', emblems: ['house', 'farm2', 'cart'], title: 'Big Houses · 2×2 Farms · Flying Carts', ribbon: 'SCENARIO' }
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GOLD = 'url(#gold)';
const INK = '#1a1208';

// A small gold disc with a number or word, at the medallion's lower right
function badge(text, x, y) {
    return `<g transform="translate(${x} ${y})"><circle r="11" fill="${GOLD}" stroke="${INK}" stroke-width="1.5"/>` +
        `<text y="4" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${text.length > 2 ? 9 : 11}" fill="${INK}">${esc(text)}</text></g>`;
}

// Emblems, drawn around (0,0) within about ±22
const EMBLEMS = {
    farm2: p => {
        const plot = (x, y) => `<rect x="${x}" y="${y}" width="17" height="17" rx="2" fill="${p.field}" stroke="${INK}" stroke-width="1.2"/>` +
            [4, 8.5, 13].map(d => `<line x1="${x + 2}" y1="${y + d}" x2="${x + 15}" y2="${y + d}" stroke="${p.furrow}" stroke-width="1.4"/>`).join('');
        return plot(-18.5, -18.5) + plot(1.5, -18.5) + plot(-18.5, 1.5) + plot(1.5, 1.5) + badge('2×2', 16, 16);
    },
    farm1: p => `<rect x="-14" y="-14" width="28" height="28" rx="3" fill="${p.field}" stroke="${INK}" stroke-width="1.4"/>` +
        [-7, -1, 5, 11].map(d => `<line x1="-11" y1="${d - 2}" x2="11" y2="${d - 2}" stroke="${p.furrow}" stroke-width="1.6"/>`).join('') + badge('1×1', 16, 16),
    wheat: p => {
        const stalk = (x, lean) => `<path d="M${x} 18 Q${x + lean} 0 ${x + lean * 1.6} -16" stroke="#c9a227" stroke-width="2" fill="none"/>` +
            [-12, -6, 0].map(t => `<ellipse cx="${x + lean * 1.3 - 3}" cy="${t}" rx="3" ry="5.5" transform="rotate(-25 ${x + lean * 1.3 - 3} ${t})" fill="${p.field}" stroke="${INK}" stroke-width=".8"/>` +
                `<ellipse cx="${x + lean * 1.3 + 3}" cy="${t - 2}" rx="3" ry="5.5" transform="rotate(25 ${x + lean * 1.3 + 3} ${t - 2})" fill="${p.field}" stroke="${INK}" stroke-width=".8"/>`).join('');
        return stalk(-8, -4) + stalk(0, 1) + stalk(8, 5) + badge('+20', 16, 16);
    },
    house: () => `<path d="M-19 -2 L0 -20 L19 -2 Z" fill="#9b3b2a" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<rect x="-15" y="-3" width="30" height="21" fill="#e9d3a2" stroke="${INK}" stroke-width="1.5"/>` +
        `<rect x="-4" y="5" width="8" height="13" fill="#6b4320" stroke="${INK}" stroke-width="1"/>` +
        `<rect x="-12" y="2" width="6" height="6" fill="#ffd36b" stroke="${INK}" stroke-width="1"/><rect x="6" y="2" width="6" height="6" fill="#ffd36b" stroke="${INK}" stroke-width="1"/>` +
        badge('+50', 16, 16),
    cart: () => `<path d="M-6 -6 C-14 -22 -26 -18 -24 -8 C-20 -12 -14 -10 -10 -6 Z" fill="#f4efe2" stroke="${INK}" stroke-width="1.2"/>` +
        `<path d="M6 -6 C14 -22 26 -18 24 -8 C20 -12 14 -10 10 -6 Z" fill="#f4efe2" stroke="${INK}" stroke-width="1.2"/>` +
        `<rect x="-17" y="-7" width="34" height="14" rx="2" fill="#a0652c" stroke="${INK}" stroke-width="1.5"/>` +
        `<line x1="-17" y1="0" x2="17" y2="0" stroke="${INK}" stroke-width="1" opacity=".5"/>` +
        `<rect x="-13" y="-14" width="10" height="8" fill="#c9a227" stroke="${INK}" stroke-width="1"/><rect x="2" y="-13" width="9" height="7" fill="#d9c08a" stroke="${INK}" stroke-width="1"/>` +
        `<circle cx="-10" cy="11" r="6" fill="#3b2a16" stroke="#e9d3a2" stroke-width="1.5"/><circle cx="10" cy="11" r="6" fill="#3b2a16" stroke="#e9d3a2" stroke-width="1.5"/>`,
    swords: () => {
        const sword = deg => `<g transform="rotate(${deg})"><rect x="-2" y="-24" width="4" height="30" rx="1" fill="#dfe6ee" stroke="${INK}" stroke-width="1.2"/>` +
            `<path d="M-2 -24 L0 -28 L2 -24 Z" fill="#dfe6ee" stroke="${INK}" stroke-width="1"/>` +
            `<rect x="-8" y="6" width="16" height="4" rx="1" fill="${GOLD}" stroke="${INK}" stroke-width="1"/>` +
            `<rect x="-1.8" y="10" width="3.6" height="9" fill="#5a3a1c" stroke="${INK}" stroke-width="1"/><circle cy="21" r="2.6" fill="${GOLD}" stroke="${INK}" stroke-width="1"/></g>`;
        return sword(-40) + sword(40);
    },
    tree: () => `<rect x="-3" y="8" width="6" height="12" fill="#6b4320" stroke="${INK}" stroke-width="1.2"/>` +
        `<path d="M0 -24 L-15 -4 L-8 -4 L-18 10 L18 10 L8 -4 L15 -4 Z" fill="#2f7a3a" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<path d="M0 -18 L-6 -8" stroke="#7cc27f" stroke-width="2" opacity=".7"/>` + badge('2×', 16, 16),
    wall: () => `<path d="M-21 18 V-6 H-15 V-12 H-9 V-6 H-3 V-12 H3 V-6 H9 V-12 H15 V-6 H21 V18 Z" fill="#a7a9ad" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
        [[-21, 0, 21, 0], [-21, 8, 21, 8], [-11, -6, -11, 0], [5, -6, 5, 0], [-3, 0, -3, 8], [13, 0, 13, 8], [-13, 8, -13, 18], [7, 8, 7, 18]]
            .map(([a, b, c, d]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke="${INK}" stroke-width="1" opacity=".55"/>`).join('') +
        `<path d="M-5 18 V10 Q0 4 5 10 V18 Z" fill="#3b2a16"/>` + badge('0', 16, 16),
    feitoria: () => `<rect x="-17" y="-4" width="34" height="22" fill="#e9d3a2" stroke="${INK}" stroke-width="1.5"/>` +
        `<path d="M-12 -4 Q0 -20 12 -4 Z" fill="#c45a2c" stroke="${INK}" stroke-width="1.5"/>` +
        `<line x1="0" y1="-16" x2="0" y2="-28" stroke="${INK}" stroke-width="1.5"/><path d="M0 -28 L11 -25 L0 -22 Z" fill="#2a5aa8" stroke="${INK}" stroke-width="1"/>` +
        `<path d="M-5 18 V9 Q0 4 5 9 V18 Z" fill="#6b4320" stroke="${INK}" stroke-width="1"/>` +
        `<circle cx="-11" cy="5" r="2.5" fill="${GOLD}"/><circle cx="11" cy="5" r="2.5" fill="${GOLD}"/>` + badge('10', 16, 16),
    caravel: () => `<path d="M-22 6 H22 L16 18 H-16 Z" fill="#7a4a22" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<line x1="-6" y1="6" x2="-6" y2="-24" stroke="${INK}" stroke-width="1.8"/><line x1="8" y1="6" x2="8" y2="-18" stroke="${INK}" stroke-width="1.8"/>` +
        `<path d="M-6 -22 Q4 -13 -6 -2 Q-16 -12 -6 -22 Z" fill="#f4efe2" stroke="${INK}" stroke-width="1.2"/>` +
        `<path d="M8 -16 Q16 -9 8 0 Q0 -8 8 -16 Z" fill="#f4efe2" stroke="${INK}" stroke-width="1.2"/>` +
        `<path d="M-9 -12 H-3 M-6 -15 V-9" stroke="#b3261e" stroke-width="2.2"/>` +
        `<path d="M-26 20 Q-18 16 -10 20 T6 20 T22 20" stroke="#bfe0ff" stroke-width="1.6" fill="none" opacity=".8"/>`
};

function scene(mod, spec) {
    const p = PALETTES[spec.palette];
    const sunX = 300 - (mod.id % 7) * 28; // the sun's place varies a little from mod to mod
    const fields = [];
    // Plots in perspective on the plain below the hills, converging on a point above the horizon
    const vx = 192, vy = 96;
    for (let r = 0; r < 3; r++) {
        const y0 = 138 + r * 22, y1 = y0 + 19;
        for (let c = -4; c < 4; c++) {
            const xAt = (x, y) => vx + (x - vx) * (y - vy) / (216 - vy);
            const xl = 192 + c * 120, xr = xl + 112;
            const pts = [[xAt(xl, y0), y0], [xAt(xr, y0), y0], [xAt(xr, y1), y1], [xAt(xl, y1), y1]];
            const shade = (r + c) % 2 ? p.field : p.furrow;
            fields.push(`<polygon points="${pts.map(([x, y]) => `${x.toFixed(1)},${y}`).join(' ')}" fill="${shade}" opacity="${0.55 + r * 0.15}"/>`);
        }
    }
    const n = spec.emblems.length;
    const gap = n === 3 ? 92 : 104;
    const medallions = spec.emblems.map((e, i) => {
        const cx = W / 2 + (i - (n - 1) / 2) * gap, cy = 98;
        return `<g transform="translate(${cx} ${cy})">` +
            `<circle r="34" fill="#000" opacity=".28" transform="translate(2 3)"/>` +
            `<circle r="33" fill="url(#medal)" stroke="${GOLD}" stroke-width="3.5"/>` +
            `<circle r="28" fill="none" stroke="${GOLD}" stroke-width="1" opacity=".6"/>` +
            `${EMBLEMS[e](p)}</g>`;
    }).join('');
    const ribbonW = Math.max(70, spec.ribbon.length * 8.2 + 24);
    const celestial = p.night
        ? `<circle cx="${sunX}" cy="44" r="40" fill="url(#glow)"/><circle cx="${sunX}" cy="44" r="13" fill="${p.sun}"/><circle cx="${sunX + 6}" cy="40" r="11" fill="${p.sky[0]}"/>` +
          [[40, 30], [80, 18], [130, 40], [230, 22], [350, 34], [20, 60]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.2" fill="#fff" opacity=".8"/>`).join('')
        : `<circle cx="${sunX}" cy="46" r="62" fill="url(#glow)"/><circle cx="${sunX}" cy="46" r="17" fill="${p.sun}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<title>${esc(mod.name)}</title>
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient>
<radialGradient id="glow"><stop offset="0" stop-color="${p.sun}" stop-opacity=".85"/><stop offset="1" stop-color="${p.sun}" stop-opacity="0"/></radialGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8e39a"/><stop offset=".5" stop-color="#d4af37"/><stop offset="1" stop-color="#8f6a1c"/></linearGradient>
<radialGradient id="medal" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#3a3f4b"/><stop offset="1" stop-color="#11141a"/></radialGradient>
<radialGradient id="vig" cx=".5" cy=".42" r=".78"><stop offset=".62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></radialGradient>
<linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1117" stop-opacity=".55"/><stop offset="1" stop-color="#0d1117" stop-opacity=".92"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
${celestial}
<path d="M0 112 Q60 78 120 100 T250 92 T384 98 V150 H0 Z" fill="${p.far}"/>
<path d="M0 132 Q80 108 170 126 T384 120 V160 H0 Z" fill="${p.near}"/>
<rect y="136" width="${W}" height="80" fill="${p.near}"/>
${fields.join('')}
${medallions}
<rect y="170" width="${W}" height="46" fill="url(#band)"/>
<line x1="14" y1="171" x2="${W - 14}" y2="171" stroke="${GOLD}" stroke-width="1.2" opacity=".8"/>
<text x="${W / 2}" y="199" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="19" font-weight="700" letter-spacing="1" fill="#f3d98a" textLength="${Math.min(W - 40, spec.title.length * 11.2)}" lengthAdjust="spacingAndGlyphs">${esc(spec.title.toUpperCase())}</text>
<g transform="translate(${W - ribbonW - 10} 12)"><path d="M0 0 H${ribbonW} V22 H0 L8 11 Z" fill="${GOLD}" stroke="${INK}" stroke-width="1.2"/>` +
`<text x="${ribbonW / 2 + 4}" y="15.5" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="11.5" font-weight="700" letter-spacing=".8" fill="${INK}">${esc(spec.ribbon)}</text></g>
<rect width="${W}" height="${H}" fill="url(#vig)"/>
<rect x="4" y="4" width="${W - 8}" height="${H - 8}" rx="6" fill="none" stroke="${GOLD}" stroke-width="2"/>
<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="4" fill="none" stroke="${GOLD}" stroke-width=".8" opacity=".55"/>
</svg>
`;
}

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'pv-mods.json'), 'utf8'));
let made = 0;
for (const mod of data.mods) {
    const spec = SCENES[mod.id];
    if (!spec) { console.log(`no scene for mod ${mod.id} (${mod.name}): add one to SCENES`); continue; }
    fs.writeFileSync(path.join(OUT, `${mod.id}.svg`), scene(mod, spec));
    made++;
}
console.log(`${made} thumbnails written to mod-thumbs/`);
