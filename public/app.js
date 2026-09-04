const signals = document.querySelector("#signals");
const watchlist = document.querySelector("#watchlist");
const form = document.querySelector("#add-stock");
const input = document.querySelector("#ticker");
const toast = document.querySelector("#toast");
const marketStatus = document.querySelector("#market-status");
const emptyTemplate = document.querySelector("#empty-state");
const suggestions = document.querySelector("#suggestions");
let selectedTicker = "";
let suggestionResults = [];
let activeSuggestion = -1;
let searchTimer;

import { displayTicker, displayTickerMessage } from "./ticker-utils.js";

const formatPrice = (value, currency) => {
  if (!Number.isFinite(value)) return "—";
  if (!currency) return value.toFixed(2);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return value.toFixed(2);
  }
};
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
  if (!response.ok) throw new Error(displayTickerMessage(body.error || "Something went wrong."));
  return body;
}

function health(entry) {
  if (entry.status === "unavailable") return `<span class="health unavailable">Unavailable</span>`;
  if (entry.sourceConflict) return `<span class="health conflict">Source conflict</span>`;
  if (entry.secondaryError) return `<span class="health delayed">Cross-check unavailable</span>`;
  if (entry.status === "stale" || entry.status === "delayed") return `<span class="health delayed">${escaped(entry.freshness?.label || "Data delayed")}</span>`;
  if (entry.status === "closed") return `<span class="health closed">${escaped(entry.freshness?.label || "Market closed")}</span>`;
  return `<span class="health live">${escaped(entry.freshness.label)}</span>`;
}

function signalCard(entry, index) {
  const signal = entry.signal;
  const direction = signal.changePercent >= 0 ? "up" : "down";
  const ticker = displayTicker(entry.ticker);
  return `<article class="signal-card ${direction}">
    <div class="rank">0${index + 1}</div>
    <div class="signal-main">
      <div class="ticker-row"><strong>${escaped(ticker)}</strong><span>${escaped(entry.name)}</span></div>
      <p>${escaped(signal.explanation)}</p>
      ${entry.sinceVisitPercent !== null ? `<small>Since last visit: <b>${formatPercent(entry.sinceVisitPercent)}</b></small>` : `<small>First check-in: baseline saved now.</small>`}
    </div>
    <div class="signal-price"><b>${formatPrice(entry.price, entry.currency)}</b><span class="${direction}">${formatPercent(signal.changePercent)}</span></div>
    <div class="score"><b>${formatNumber(signal.score)}</b><span>signal score</span></div>
  </article>`;
}

function stockRow(entry) {
  const ticker = displayTicker(entry.ticker);
  if (entry.status === "unavailable") {
    return `<tr><td><strong>${escaped(ticker)}</strong></td><td colspan="4" class="unavailable-message">${escaped(entry.error)}</td><td><button class="remove" data-ticker="${escaped(entry.ticker)}">Remove</button></td></tr>`;
  }
  const direction = entry.signal.changePercent >= 0 ? "up" : "down";
  const volume = entry.signal.volumeRatio ? `${formatNumber(entry.signal.volumeRatio)}x avg` : "No volume";
  return `<tr>
    <td><strong>${escaped(ticker)}</strong><span>${escaped(entry.name)}</span></td>
    <td class="number">${formatPrice(entry.price, entry.currency)}</td>
    <td class="number ${direction}">${formatPercent(entry.signal.changePercent)}</td>
    <td>${volume}</td><td>${health(entry)}</td>
    <td><button class="remove" data-ticker="${escaped(entry.ticker)}" aria-label="Remove ${escaped(ticker)}">×</button></td>
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
  const hasConcern = entries.some((entry) => (entry.status !== "live" && entry.status !== "closed") || entry.sourceConflict);
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
  const ticker = selectedTicker || input.value.trim();
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
    selectedTicker = "";
    notice(`${displayTicker(ticker)} added to your watchlist.`);
    await load(false);
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

function closeSuggestions() {
  suggestions.hidden = true;
  suggestions.replaceChildren();
  suggestionResults = [];
  activeSuggestion = -1;
}

function chooseSuggestion(index) {
  const result = suggestionResults[index];
  if (!result) return;
  selectedTicker = result.symbol;
  input.value = result.name;
  closeSuggestions();
}

function renderSuggestions(results) {
  suggestionResults = results;
  activeSuggestion = -1;
  suggestions.replaceChildren();
  results.forEach((result, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion";
    button.setAttribute("role", "option");
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      chooseSuggestion(index);
    });
    const name = document.createElement("strong");
    name.textContent = result.name;
    const detail = document.createElement("span");
    detail.textContent = `${displayTicker(result.symbol)}${result.exchange ? ` · ${result.exchange}` : ""}`;
    button.append(name, detail);
    suggestions.append(button);
  });
  suggestions.hidden = results.length === 0;
}

input.addEventListener("input", () => {
  selectedTicker = "";
  clearTimeout(searchTimer);
  const query = input.value.trim();
  if (query.length < 2) return closeSuggestions();
  searchTimer = setTimeout(async () => {
    try {
      const body = await request(`/api/search?q=${encodeURIComponent(query)}`);
      if (input.value.trim() === query && !selectedTicker) renderSuggestions(body.results);
    } catch {
      closeSuggestions();
    }
  }, 250);
});

input.addEventListener("keydown", (event) => {
  if (suggestions.hidden || !suggestionResults.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    activeSuggestion = (activeSuggestion + (event.key === "ArrowDown" ? 1 : -1) + suggestionResults.length) % suggestionResults.length;
    [...suggestions.children].forEach((node, index) => node.classList.toggle("active", index === activeSuggestion));
  } else if (event.key === "Enter" && activeSuggestion >= 0) {
    event.preventDefault();
    chooseSuggestion(activeSuggestion);
  } else if (event.key === "Escape") {
    closeSuggestions();
  }
});

document.addEventListener("click", (event) => {
  if (!form.contains(event.target)) closeSuggestions();
});

watchlist.addEventListener("click", async (event) => {
  const button = event.target.closest(".remove");
  if (!button) return;
  try {
    await request(`/api/watchlist/${encodeURIComponent(button.dataset.ticker)}`, { method: "DELETE" });
    notice(`${displayTicker(button.dataset.ticker)} removed.`);
    await load(false);
  } catch (error) {
    notice(error.message, true);
  }
});

document.querySelector("#refresh").addEventListener("click", () => load(true));
load(true);
