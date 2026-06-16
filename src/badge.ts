// Embeddable SVG status badge ("<label> | <status>") in the flat shields.io style. Rendered for
// public monitors only (see routes.ts). Reuses the shared status→label/colour mapping.
import { statusMeta } from './status-meta';

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Rough text width for an 11px sans font — good enough for badge geometry.
function textWidth(s: string): number {
	return Math.round(s.length * 6.5);
}

export function buildBadgeSvg(label: string, status: string | null, paused: boolean): string {
	const { text, color } = statusMeta(status, paused);
	const padX = 7;
	const iconW = 14;
	const iconGap = 4;
	const h = 20;
	const lw = iconW + iconGap + textWidth(label) + padX * 2;
	const rw = textWidth(text) + padX * 2;
	const w = lw + rw;
	const iconX = padX;
	const iconY = 4;
	const labelX = padX + iconW + iconGap + textWidth(label) / 2;
	const rx = lw + rw / 2;
	const aria = `${esc(label)}: ${esc(text)}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="${aria}">
  <title>${aria}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="${h}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${h}" fill="#555"/>
    <rect x="${lw}" width="${rw}" height="${h}" fill="${color}"/>
    <rect width="${w}" height="${h}" fill="url(#s)"/>
  </g>
  <g transform="translate(${iconX} ${iconY}) scale(.011)" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
    <path fill="#fff" stroke="none" d="M316 904c-88 0-158-70-158-158s70-164 158-164c-5-73 49-135 114-135 17 0 33 3 46 8 34-87 121-148 220-148 127 0 232 101 237 228 12-2 24-3 37-3 86 0 154 69 154 154 0 119-88 218-196 218H316Z"/>
    <path d="M166 759h198c10 0 19-4 25-12l24-32 55 75 80-277 73 349 64-190 47 87h187" stroke="#555" stroke-width="52"/>
    <circle cx="962" cy="759" r="32" stroke="#555" stroke-width="52"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text>
    <text x="${labelX}" y="14">${esc(label)}</text>
    <text x="${rx}" y="15" fill="#010101" fill-opacity=".3">${esc(text)}</text>
    <text x="${rx}" y="14">${esc(text)}</text>
  </g>
</svg>`;
}
