const signals = document.querySelector("#signals");
const watchlist = document.querySelector("#watchlist");
const form = document.querySelector("#add-stock");
const input = document.querySelector("#ticker");
const toast = document.querySelector("#toast");
const marketStatus = document.querySelector("#market-status");
const emptyTemplate = document.querySelector("#empty-state");

const formatPrice = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value)
    : "—";
const formatPercent = (value) => (Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "—");
const formatNumber = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "—");
const escaped = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);

function notice(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3400);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Something went wrong.");
  return body;
}

function health(entry) {
  if (entry.status === "unavailable") return `<span class="health unavailable">Unavailable</span>`;
  if (entry.sourceConflict) return `<span class="health conflict">Source conflict</span>`;
  if (entry.secondaryError) return `<span class="health delayed">Cross-check unavailable</span>`;
  if (entry.status === "stale" || entry.status === "delayed") return `<span class="health delayed">${escaped(entry.freshness?.label || "Data delayed")}</span>`;
  return `<span class="health live">${escaped(entry.freshness.label)}</span>`;
}

function signalCard(entry, index) {
  const signal = entry.signal;
  const direction = signal.changePercent >= 0 ? "up" : "down";
  return `<article class="signal-card ${direction}">
    <div class="rank">0${index + 1}</div>
    <div class="signal-main">
      <div class="ticker-row"><strong>${escaped(entry.ticker)}</strong><span>${escaped(entry.name)}</span></div>
      <p>${escaped(signal.explanation)}</p>
      ${entry.sinceVisitPercent !== null ? `<small>Since last visit: <b>${formatPercent(entry.sinceVisitPercent)}</b></small>` : `<small>First check-in: baseline saved now.</small>`}
    </div>
    <div class="signal-price"><b>${formatPrice(entry.price)}</b><span class="${direction}">${formatPercent(signal.changePercent)}</span></div>
    <div class="score"><b>${formatNumber(signal.score)}</b><span>signal score</span></div>
  </article>`;
}

function stockRow(entry) {
  if (entry.status === "unavailable") {
    return `<tr><td><strong>${escaped(entry.ticker)}</strong></td><td colspan="4" class="unavailable-message">${escaped(entry.error)}</td><td><button class="remove" data-ticker="${escaped(entry.ticker)}">Remove</button></td></tr>`;
  }
  const direction = entry.signal.changePercent >= 0 ? "up" : "down";
  const volume = entry.signal.volumeRatio ? `${formatNumber(entry.signal.volumeRatio)}x avg` : "No volume";
  return `<tr>
    <td><strong>${escaped(entry.ticker)}</strong><span>${escaped(entry.name)}</span></td>
    <td class="number">${formatPrice(entry.price)}</td>
    <td class="number ${direction}">${formatPercent(entry.signal.changePercent)}</td>
    <td>${volume}</td><td>${health(entry)}</td>
    <td><button class="remove" data-ticker="${escaped(entry.ticker)}" aria-label="Remove ${escaped(entry.ticker)}">×</button></td>
  </tr>`;
}

function render(data) {
  const entries = data.entries;
  document.querySelector("#stock-count").textContent = `${entries.length} ${entries.length === 1 ? "stock" : "stocks"}`;
  document.querySelector("#last-visit").textContent = data.lastSeenAt
    ? `Compared with your last check at ${new Date(data.lastSeenAt).toLocaleString()}.`
    : "Your first check saves a baseline. Return later to see changes relative to this moment.";
  if (!entries.length) {
    signals.replaceChildren(emptyTemplate.content.cloneNode(true));
    watchlist.innerHTML = "";
  } else {
    const flagged = entries.filter((entry) => entry.signal?.meaningful);
    signals.innerHTML = flagged.length
      ? flagged.map(signalCard).join("")
      : `<div class="calm"><b>No unusual moves right now.</b><span>Your stocks moved within their normal range, or volume did not confirm the move.</span></div>`;
    watchlist.innerHTML = entries.map(stockRow).join("");
  }
  const hasConcern = entries.some((entry) => entry.status !== "live" || entry.sourceConflict);
  marketStatus.textContent = hasConcern ? "Some data needs attention" : "Market data healthy";
  marketStatus.classList.toggle("attention", hasConcern);
}

async function load(markSeen = false) {
  signals.setAttribute("aria-busy", "true");
  try {
    render(await request(markSeen ? "/api/changes" : "/api/watchlist"));
  } catch (error) {
    notice(error.message, true);
  } finally {
    signals.removeAttribute("aria-busy");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const ticker = input.value.trim();
  if (!ticker) return;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await request("/api/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticker }),
    });
    input.value = "";
    notice(`${ticker.toUpperCase()} added to your watchlist.`);
    await load(false);
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

watchlist.addEventListener("click", async (event) => {
  const button = event.target.closest(".remove");
  if (!button) return;
  try {
    await request(`/api/watchlist/${encodeURIComponent(button.dataset.ticker)}`, { method: "DELETE" });
    notice(`${button.dataset.ticker} removed.`);
    await load(false);
  } catch (error) {
    notice(error.message, true);
  }
});

document.querySelector("#refresh").addEventListener("click", () => load(true));
load(true);
