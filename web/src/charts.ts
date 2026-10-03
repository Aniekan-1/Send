// Column chart for one series over time (claims per day). Hand-rolled SVG:
// thin columns with a 4px rounded data end, hairline grid, hover tooltip, and a table view.
import { escapeHtml } from "./ui";

export interface Point {
  label: string; // x-axis label, e.g. "Oct 3"
  value: number;
  tooltip: string; // first line of the tooltip (the value, formatted)
  detail?: string; // second line
}

const W = 720;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 40 };
const MAX_BAR = 24;

function niceMax(v: number): number {
  if (v <= 0) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= v / 4)! * pow;
  return Math.ceil(v / step) * step;
}

/** Column with square base and 4px rounded top. */
function column(x: number, y: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function columnChart(host: HTMLElement, points: Point[], opts: { ariaLabel: string; tickFormat: (v: number) => string }) {
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(points.length, 1);
  const barW = Math.min(MAX_BAR, Math.max(2, slot - 2));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const labelEvery = Math.ceil(points.length / 8);
  // Label the newest point and every Nth one counting back from it, so labels never collide.
  const labelled = (i: number) => (points.length - 1 - i) % labelEvery === 0;

  const grid = ticks
    .map((t) => `<line class="grid-line" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(t)}" y2="${y(t)}"/>
      <text class="axis-text" x="${PAD.left - 8}" y="${y(t) + 4}" text-anchor="end">${escapeHtml(opts.tickFormat(t))}</text>`)
    .join("");

  const bars = points
    .map((p, i) => {
      const cx = PAD.left + slot * i + slot / 2;
      const top = y(p.value);
      return `<g data-i="${i}">
        <rect class="hit" x="${PAD.left + slot * i}" y="${PAD.top}" width="${slot}" height="${innerH}"/>
        <path class="bar" d="${column(cx - barW / 2, top, barW, PAD.top + innerH - top)}"/>
        ${labelled(i)
          ? `<text class="axis-text" x="${cx}" y="${H - 6}" text-anchor="middle">${escapeHtml(p.label)}</text>`
          : ""}
      </g>`;
    })
    .join("");

  host.classList.add("chart");
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(opts.ariaLabel)}">${grid}${bars}</svg>
    <div class="tooltip" hidden></div>`;

  const tip = host.querySelector<HTMLElement>(".tooltip")!;
  const svg = host.querySelector("svg")!;
  host.querySelectorAll<SVGGElement>("g[data-i]").forEach((g) => {
    const p = points[Number(g.dataset.i)];
    const bar = g.querySelector(".bar");
    g.addEventListener("pointerenter", () => {
      bar?.classList.add("active");
      const box = (bar ?? g).getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      const scale = svg.getBoundingClientRect().width / W;
      tip.innerHTML = `<strong>${escapeHtml(p.tooltip)}</strong>${escapeHtml(p.label)}${p.detail ? " · " + escapeHtml(p.detail) : ""}`;
      tip.style.left = `${box.left - hostBox.left + box.width / 2}px`;
      tip.style.top = `${Math.min(box.top - hostBox.top, y(0) * scale - 4)}px`;
      tip.hidden = false;
    });
    g.addEventListener("pointerleave", () => {
      bar?.classList.remove("active");
      tip.hidden = true;
    });
  });
}

/** Accessible table view of the same points (toggle under the chart). */
export function chartTable(points: Point[], headers: [string, string, string]): string {
  const rows = points
    .filter((p) => p.value > 0)
    .reverse()
    .map((p) => `<tr><td>${escapeHtml(p.label)}</td><td class="r">${escapeHtml(p.tooltip)}</td><td class="r">${escapeHtml(p.detail ?? "")}</td></tr>`)
    .join("");
  return `<div class="table-wrap"><table class="data"><thead><tr><th>${headers[0]}</th><th class="r">${headers[1]}</th><th class="r">${headers[2]}</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="3" class="muted">No claims in this period</td></tr>`}</tbody></table></div>`;
}
