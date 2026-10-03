// Landing page: live totals from the relayer's index.
import { dashboardApi } from "./api";
import { count, usdCompact } from "./format";
import { renderNav } from "./nav";

renderNav();

async function loadProof() {
  const proof = document.getElementById("proof")!;
  try {
    const s = await dashboardApi.publicStats();
    const values: Record<string, string> = {
      distributed: usdCompact(s.distributed),
      recipients: count(s.recipients),
      claimed: count(s.claimed),
      campaigns: count(s.campaigns),
    };
    proof.querySelectorAll<HTMLElement>("[data-stat]").forEach((el) => (el.textContent = values[el.dataset.stat!]));
  } catch {
    proof.hidden = true; // the landing page still works without live numbers
  }
}

loadProof();
