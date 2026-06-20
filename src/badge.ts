// Embeddable SVG status badge ("<label> | <status>") in the flat GitHub/Shields.io style. Rendered
// for public monitors and the overall site (see routes.ts).
//
// Layout (height 20, dynamic width):
//   left segment (dark grey): 7px pad → 12px logo → 5px gap → label text → 9px pad
//   right segment (status colour): 9px pad → status text → 9px pad
// Text is drawn at 10× then scaled by .1 (font-size 110, baseline y=145 → 14.5) for crisp sub-pixel
// positioning, and each run is pinned to its measured width via `textLength` so padding stays exact.
//
// Badges reuse the status page vocabulary (operational/degraded/outage/paused/unknown), just
// lowercased to read like a conventional README badge, plus a purple "maintenance" state.
import { statusMeta } from './status-meta';

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Status → lowercase text + colour: shared statusMeta (green/amber/red/grey) plus purple maintenance.
function badgeStatus(status: string | null, paused: boolean): { text: string; color: string } {
	if (!paused && status === 'maintenance') return { text: 'maintenance', color: '#7c3aed' };
	const { text, color } = statusMeta(status, paused);
	return { text: text.toLowerCase(), color };
}

// Approximate per-character advance for 11px Verdana. The estimate only affects glyph density (text
// is stretched to exactly this width via `textLength`), so rough buckets are enough.
const NARROW = new Set([...`ijl.,:;!|'\` `]);
const WIDE = new Set([...'mwMW@%']);
function textWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		if (NARROW.has(ch)) w += 4;
		else if (WIDE.has(ch)) w += 10;
		else if (ch >= 'A' && ch <= 'Z') w += 8;
		else w += 7;
	}
	return w;
}

// Brand mark drawn into the 12px logo box via the 1254-unit viewBox (white cloud + heartbeat trace).
const BRAND_ICON =
	`<path fill="#fff" stroke="none" d="M316 904c-88 0-158-70-158-158s70-164 158-164c-5-73 49-135 114-135 17 0 33 3 46 8 34-87 121-148 220-148 127 0 232 101 237 228 12-2 24-3 37-3 86 0 154 69 154 154 0 119-88 218-196 218H316Z"/>` +
	`<path d="M166 759h198c10 0 19-4 25-12l24-32 55 75 80-277 73 349 64-190 47 87h187" stroke="#555" stroke-width="60"/>` +
	`<circle cx="962" cy="759" r="32" stroke="#555" stroke-width="60"/>`;

const H = 20; // badge height
const ICON_PAD = 7; // left edge → icon
const ICON = 12; // logo box size
const ICON_GAP = 5; // icon → label text
const LABEL_PAD = 9; // label text → segment divider
const MSG_PAD = 9; // status text padding (each side)

export function buildBadgeSvg(label: string, status: string | null, paused: boolean): string {
	const { text, color } = badgeStatus(status, paused);

	const labelW = textWidth(label);
	const msgW = textWidth(text);

	const labelTextX = ICON_PAD + ICON + ICON_GAP; // = 24
	const leftW = labelTextX + labelW + LABEL_PAD; // grey label segment width
	const rightW = msgW + MSG_PAD * 2; // coloured status segment width
	const w = leftW + rightW;

	const iconY = (H - ICON) / 2; // vertically centred
	const iconScale = (ICON / 1254).toFixed(4);

	// Text centres in 1× units; emitted at 10× (·10) to pair with transform="scale(.1)".
	const labelX = ((labelTextX + labelW / 2) * 10).toFixed(0);
	const msgX = ((leftW + rightW / 2) * 10).toFixed(0);
	const labelLen = (labelW * 10).toFixed(0);
	const msgLen = (msgW * 10).toFixed(0);

	const aria = `${esc(label)}: ${esc(text)}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" role="img" aria-label="${aria}">
  <title>${aria}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="${H}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="${H}" fill="#555"/>
    <rect x="${leftW}" width="${rightW}" height="${H}" fill="${color}"/>
    <rect width="${w}" height="${H}" fill="url(#s)"/>
  </g>
  <g transform="translate(${ICON_PAD} ${iconY}) scale(${iconScale})" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round" opacity=".95">${BRAND_ICON}</g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${labelX}" y="155" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${labelLen}">${esc(label)}</text>
    <text x="${labelX}" y="145" transform="scale(.1)" textLength="${labelLen}">${esc(label)}</text>
    <text aria-hidden="true" x="${msgX}" y="155" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${msgLen}">${esc(text)}</text>
    <text x="${msgX}" y="145" transform="scale(.1)" textLength="${msgLen}">${esc(text)}</text>
  </g>
</svg>`;
}
