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
	const h = 20;
	const lw = textWidth(label) + padX * 2;
	const rw = textWidth(text) + padX * 2;
	const w = lw + rw;
	const lx = lw / 2;
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
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lx}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text>
    <text x="${lx}" y="14">${esc(label)}</text>
    <text x="${rx}" y="15" fill="#010101" fill-opacity=".3">${esc(text)}</text>
    <text x="${rx}" y="14">${esc(text)}</text>
  </g>
</svg>`;
}
