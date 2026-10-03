// Shared top bar. Recipients' pages (claim, wallet) get a minimal version: they don't need organizer links.
import { html } from "./ui";

const LINKS = [
  ["/", "Home"],
  ["/organize.html", "Create drops"],
  ["/dashboard.html", "Dashboard"],
  ["/wallet.html", "My wallet"],
] as const;

export function renderNav(opts: { minimal?: boolean } = {}) {
  const here = location.pathname === "/index.html" ? "/" : location.pathname;
  const links = opts.minimal
    ? ""
    : LINKS.map(([href, label]) =>
        href === here ? `<a href="${href}" aria-current="page">${label}</a>` : `<a href="${href}">${label}</a>`,
      ).join("");
  const nav = document.createElement("header");
  nav.className = "nav no-print";
  nav.innerHTML = html`<div class="container">
      <a class="brand" href="/"><span class="logo" aria-hidden="true">$</span><span class="word">Dollar Drop</span></a>
    </div>`;
  if (links) {
    const box = document.createElement("nav");
    box.className = "nav-links";
    box.setAttribute("aria-label", "Main");
    box.innerHTML = links;
    nav.firstElementChild!.append(box);
  }
  document.body.prepend(nav);
}
