import { displayTicker, displayTickerMessage } from "./ticker-utils.js";

const signals = document.querySelector("#signals");
const watchlist = document.querySelector("#watchlist");
const form = document.querySelector("#add-stock");
const input = document.querySelector("#ticker");
const toast = document.querySelector("#toast");
const marketStatus = document.querySelector("#market-status");
const emptyTemplate = document.querySelector("#empty-state");
const suggestions = document.querySelector("#suggestions");
const accountDialog = document.querySelector("#account-dialog");
const detailDialog = document.querySelector("#detail-dialog");
let selectedTicker = "";
let suggestionResults = [];
let activeSuggestion = -1;
let searchTimer;
let session = { authenticated: false };

const formatPrice = (value, currency) => {
  if (!Number.isFinite(value)) return "—";
  if (!currency) return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : undefined, {
      style: "currency", currency, maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
};
const formatPercent = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "—";
const formatNumber = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : "—";
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
  return `<span class="health live">${escaped(entry.freshness?.label || "Live")}</span>`;
}

function peerLine(peer) {
  if (!peer?.meaningful) return "";
  return `<small class="peer-line"><b>Peer divergence:</b> ${escaped(peer.explanation)}</small>`;
}

function transitionBadges(entry) {
  const labels = [];
  if (entry.transition?.becameUnusual) labels.push("NEW SIGNAL");
  if (entry.transition?.newPeerDivergence) labels.push("PEER BREAKOUT");
  return labels.length ? `<div class="transition-badges">${labels.map((label) => `<span>${label}</span>`).join("")}</div>` : "";
}

function renderTransitions(transitions, alertLevel) {
  const target = document.querySelector("#transition-summary");
  if (!target) return;
  if (alertLevel === "off") {
    target.hidden = false;
    target.innerHTML = `<b>Signal digest paused</b><span>Attention transitions are still tracked for your next visit.</span>`;
    return;
  }
  if (!transitions || transitions.firstVisit) {
    target.hidden = true;
    target.replaceChildren();
    return;
  }
  const pieces = [];
  if (transitions.becameUnusual?.length) pieces.push(`<span><b>${transitions.becameUnusual.length}</b> became unusual</span>`);
  if (transitions.returnedToNormal?.length) pieces.push(`<span><b>${transitions.returnedToNormal.length}</b> returned to normal</span>`);
  if (transitions.newPeerDivergence?.length) pieces.push(`<span><b>${transitions.newPeerDivergence.length}</b> new peer divergence</span>`);
  if (transitions.largestMove) {
    pieces.push(`<span>Largest move: <b>${escaped(displayTicker(transitions.largestMove.ticker))} ${formatPercent(transitions.largestMove.percent)}</b></span>`);
  }
  target.hidden = false;
  target.innerHTML = pieces.length
    ? `<strong>SINCE YOUR LAST VISIT</strong>${pieces.join("")}`
    : `<strong>SINCE YOUR LAST VISIT</strong><span>No attention-state changes since your last visit.</span>`;
}

function signalCard(entry, index) {
  const signal = entry.signal;
  const direction = signal.changePercent >= 0 ? "up" : "down";
  return `<article class="signal-card ${direction}" data-detail="${escaped(entry.ticker)}">
    <div class="rank">${String(index + 1).padStart(2, "0")}</div>
    <div class="signal-main">
      <div class="ticker-row"><strong>${escaped(displayTicker(entry.ticker))}</strong><span>${escaped(entry.name)}</span></div>
      <p>${escaped(signal.explanation)}</p>
      ${transitionBadges(entry)}
      ${peerLine(entry.peer)}
      ${entry.sinceVisitPercent !== null ? `<small class="since-visit ${entry.sinceVisitPercent >= 0 ? "up" : "down"}">Since last visit: <b>${formatPercent(entry.sinceVisitPercent)}</b></small>` : `<small>First check-in: baseline saved now.</small>`}
    </div>
    <div class="signal-price"><b>${formatPrice(entry.price, entry.currency)}</b><span class="${direction}">${formatPercent(signal.changePercent)}</span></div>
    <div class="score"><b>${formatNumber(entry.attentionScore ?? entry.priority ?? signal.score)}</b><span>attention score</span></div>
  </article>`;
}

function stockRow(entry) {
  const ticker = displayTicker(entry.ticker);
  if (entry.status === "unavailable") {
    return `<tr><td><strong>${escaped(ticker)}</strong></td><td colspan="4" class="unavailable-message">${escaped(entry.error)}</td><td><button class="remove" data-ticker="${escaped(entry.ticker)}">Remove</button></td></tr>`;
  }
  const direction = entry.signal.changePercent >= 0 ? "up" : "down";
  const volume = entry.signal.volumeRatio ? `${formatNumber(entry.signal.volumeRatio)}x avg` : "No volume";
  return `<tr class="stock-row" data-detail="${escaped(entry.ticker)}">
    <td><strong>${escaped(ticker)}</strong><span>${escaped(entry.name)}</span></td>
    <td class="number">${formatPrice(entry.price, entry.currency)}</td>
    <td class="number ${direction}">${formatPercent(entry.signal.changePercent)}</td>
    <td>${volume}</td><td>${health(entry)}</td>
    <td><button class="remove" data-ticker="${escaped(entry.ticker)}" aria-label="Remove ${escaped(ticker)}">×</button></td>
  </tr>`;
}

function renderMarket(market) {
  if (!market) return;
  marketStatus.textContent = market.label;
  marketStatus.classList.toggle("attention", !market.open);
  document.querySelector("#market-session-title").textContent = market.label;
  document.querySelector("#market-session-copy").textContent = `${market.hours}. ${market.open ? "Live quotes are assessed for freshness." : "Previous-session quotes are kept separate from stale-data warnings."}`;
}

function render(data) {
  const entries = data.entries;
  document.querySelector("#stock-count").textContent = `${entries.length} ${entries.length === 1 ? "stock" : "stocks"}`;
  document.querySelector("#last-visit").textContent = data.lastSeenAt
    ? `Compared with your last check at ${new Date(data.lastSeenAt).toLocaleString()}.`
    : "Your first check saves a baseline. Return later to see changes relative to this moment.";
  const alertLevel = data.preferences?.alertLevel || "high";
  if (!entries.length) {
    signals.replaceChildren(emptyTemplate.content.cloneNode(true));
    watchlist.innerHTML = "";
  } else {
    const flagged = entries.filter((entry) => entry.digestVisible);
    signals.innerHTML = alertLevel === "off"
      ? `<div class="calm"><b>Signal digest is paused.</b><span>Your full watchlist is still being tracked.</span></div>`
      : flagged.length
        ? flagged.map(signalCard).join("")
        : `<div class="calm"><b>No ${alertLevel === "high" ? "high-confidence " : ""}unusual moves right now.</b><span>Your watchlist is still being monitored for relative surprise and peer divergence.</span></div>`;
    watchlist.innerHTML = entries.map(stockRow).join("");
  }
  renderTransitions(data.transitions, alertLevel);
  renderMarket(data.market);
  document.querySelector("#alert-level").value = alertLevel;
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
    button.innerHTML = `<strong>${escaped(result.name)}</strong><span>${escaped(displayTicker(result.symbol))}${result.exchange ? ` · ${escaped(result.exchange)}` : ""}</span>`;
    suggestions.append(button);
  });
  suggestions.hidden = results.length === 0;
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${name}-view`));
  document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  if (name === "history") loadHistory();
}

async function loadHistory() {
  const target = document.querySelector("#history-list");
  target.innerHTML = `<div class="calm"><b>Loading signal history…</b></div>`;
  try {
    const { history } = await request("/api/history");
    target.innerHTML = history.length
      ? history.map((item) => `<article class="history-item">
          <div><strong>${escaped(displayTicker(item.ticker))}</strong><span>${new Date(item.at).toLocaleDateString()}</span></div>
          <p>${escaped(item.explanation)}</p><b class="${item.changePercent >= 0 ? "up" : "down"}">${formatPercent(item.changePercent)}</b>
        </article>`).join("")
      : `<div class="calm"><b>No historical signals yet.</b><span>Add stocks and revisit after market movements to build your signal record.</span></div>`;
  } catch (error) {
    target.innerHTML = `<div class="calm"><b>Could not load signal history.</b><span>${escaped(error.message)}</span></div>`;
  }
}

async function showDetail(ticker) {
  detailDialog.showModal();
  const target = document.querySelector("#stock-detail");
  target.innerHTML = `<p class="label">STOCK DETAIL</p><h2>${escaped(displayTicker(ticker))}</h2><p>Loading detail…</p>`;
  try {
    const entry = await request(`/api/stocks/${encodeURIComponent(ticker)}`);
    const points = entry.history.map((day) => day.close).filter(Number.isFinite);
    const minimum = Math.min(...points);
    const maximum = Math.max(...points);
    target.innerHTML = `<p class="label">${escaped(entry.exchange || "MARKET")} · LAST 30 SESSIONS</p>
      <h2>${escaped(displayTicker(entry.ticker))}</h2><p class="detail-name">${escaped(entry.name)}</p>
      <div class="detail-price">${formatPrice(entry.price, entry.currency)} <span class="${entry.signal.changePercent >= 0 ? "up" : "down"}">${formatPercent(entry.signal.changePercent)}</span></div>
      <p>${escaped(entry.signal.explanation)}</p>
      <div class="range-chart">${points.map((price) => `<i style="height:${Math.max(8, ((price - minimum) / Math.max(maximum - minimum, 0.01)) * 100)}%"></i>`).join("")}</div>
      <div class="detail-stats"><span><b>${formatNumber(entry.signal.volatility, 2)}%</b> usual swing</span><span><b>${entry.signal.volumeRatio ? `${formatNumber(entry.signal.volumeRatio)}x` : "—"}</b> volume</span><span><b>${entry.historicSignals.length}</b> past signals</span></div>`;
  } catch (error) {
    target.innerHTML = `<p class="label">STOCK DETAIL</p><h2>Unavailable</h2><p>${escaped(error.message)}</p>`;
  }
}

function renderSession() {
  const title = document.querySelector("#account-title");
  const copy = document.querySelector("#account-copy");
  const button = document.querySelector("#account-settings-button");
  if (session.authenticated) {
    document.querySelector("#account-button").textContent = session.email;
    title.textContent = "Account connected";
    copy.textContent = `Your watchlist is linked to ${session.email} and can be accessed after signing in on another device.`;
    button.textContent = "Manage account";
  } else {
    document.querySelector("#account-button").textContent = "Save across devices";
    title.textContent = "Device-only watchlist";
    copy.textContent = "Create an account to intentionally access the same watchlist from another device.";
    button.textContent = "Create account";
  }
}

async function loadSession() {
  session = await request("/api/session");
  renderSession();
}

function openAccountDialog(login = false) {
  const form = document.querySelector("#auth-form");
  const switchButton = document.querySelector("#auth-switch");
  const connected = document.querySelector("#account-connected");
  if (session.authenticated) {
    document.querySelector("#auth-heading").textContent = "Account connected";
    document.querySelector("#auth-copy").textContent = "Your watchlist is available after signing in on another device.";
    document.querySelector("#account-email").textContent = session.email || "your account";
    form.hidden = true;
    switchButton.hidden = true;
    connected.hidden = false;
  } else {
    document.querySelector("#auth-heading").textContent = login ? "Sign in to your account" : "Create your account";
    document.querySelector("#auth-copy").textContent = login
      ? "Sign in to restore your saved watchlist on this device."
      : "Your current device watchlist will be kept and linked to your account.";
    document.querySelector("#auth-submit").textContent = login ? "Sign in" : "Create account";
    document.querySelector("#auth-password").autocomplete = login ? "current-password" : "new-password";
    switchButton.textContent = login ? "New here? Create an account" : "Already have an account? Sign in";
    form.dataset.mode = login ? "login" : "register";
    form.hidden = false;
    switchButton.hidden = false;
    connected.hidden = true;
  }
  if (!accountDialog.open) accountDialog.showModal();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const ticker = selectedTicker || input.value.trim();
  if (!ticker) return;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await request("/api/watchlist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticker }) });
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
  } else if (event.key === "Escape") closeSuggestions();
});

document.addEventListener("click", (event) => {
  if (!form.contains(event.target)) closeSuggestions();
});
document.querySelectorAll(".nav-link").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
document.querySelector("#refresh").addEventListener("click", () => load(true));
document.querySelector("#account-button").addEventListener("click", () => openAccountDialog(session.authenticated));
document.querySelector("#account-settings-button").addEventListener("click", () => openAccountDialog(session.authenticated));
document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelector("#auth-switch").addEventListener("click", () => openAccountDialog(document.querySelector("#auth-form").dataset.mode !== "login"));
document.querySelector("#logout-button").addEventListener("click", async () => {
  await request("/api/auth/logout", { method: "POST" });
  accountDialog.close();
  await loadSession();
  notice("Signed out. Your account data remains safe.");
});
document.querySelector("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = event.currentTarget.dataset.mode;
  const button = document.querySelector("#auth-submit");
  button.disabled = true;
  try {
    await request(`/api/auth/${mode}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: document.querySelector("#auth-email").value, password: document.querySelector("#auth-password").value }),
    });
    accountDialog.close();
    await loadSession();
    await load(false);
    notice(mode === "login" ? "Watchlist restored." : "Account created. Your watchlist now syncs across devices.");
  } catch (error) {
    notice(error.message, true);
  } finally {
    document.querySelector("#auth-password").value = "";
    button.disabled = false;
  }
});
document.querySelector("#save-settings").addEventListener("click", async () => {
  try {
    await request("/api/preferences", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ alertLevel: document.querySelector("#alert-level").value }) });
    await load(false);
    notice("Signal digest setting saved.");
  } catch (error) {
    notice(error.message, true);
  }
});
watchlist.addEventListener("click", async (event) => {
  const remove = event.target.closest(".remove");
  if (remove) {
    try {
      await request(`/api/watchlist/${encodeURIComponent(remove.dataset.ticker)}`, { method: "DELETE" });
      notice(`${displayTicker(remove.dataset.ticker)} removed.`);
      await load(false);
    } catch (error) {
      notice(error.message, true);
    }
    return;
  }
  const row = event.target.closest("[data-detail]");
  if (row) showDetail(row.dataset.detail);
});
signals.addEventListener("click", (event) => {
  const card = event.target.closest("[data-detail]");
  if (card) showDetail(card.dataset.detail);
});

Promise.all([loadSession(), load(true)]).catch((error) => notice(error.message, true));
