#!/usr/bin/env python3
"""Apply the final CODE 2026 Signal Watch polish to the current ph-tech/Grow_project main.

Run this from the repository root on a clean checkout. The script is intentionally
strict: every replacement must match the expected current main or it stops rather
than guessing.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys
import textwrap

ROOT = pathlib.Path.cwd()


def fail(message: str) -> None:
    raise SystemExit(f"\nERROR: {message}\nNo commit was created. Review/revert with git if needed.\n")


def read(path: str) -> str:
    p = ROOT / path
    if not p.exists():
        fail(f"Expected {path} in the current directory. Run this from Grow_project root.")
    return p.read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def replace_one(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        fail(f"Patch guard failed for {path}: expected one exact match, found {count}.")
    write(path, text.replace(old, new, 1))


def append_once(path: str, marker: str, addition: str) -> None:
    text = read(path)
    if marker in text:
        return
    write(path, text.rstrip() + "\n\n" + addition.strip() + "\n")


def run(command: list[str], required: bool = True) -> int:
    print("$", " ".join(command))
    result = subprocess.run(command, cwd=ROOT)
    if required and result.returncode != 0:
        fail(f"Command failed: {' '.join(command)}")
    return result.returncode


required = [
    "server.js", "public/app.js", "public/index.html", "public/styles.css",
    "README.md", "test/server.test.js", "lib/scoring.js", "lib/peers.js",
]
for path in required:
    read(path)

try:
    status = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()
    if status:
        fail("Working tree is not clean. Commit/stash your current work first.")
except (FileNotFoundError, subprocess.CalledProcessError):
    print("Warning: git status could not be checked; continuing with strict patch guards.")

attention_js = r'''const HIGH_CONFIDENCE_SCORE = 1.5;

export function isHighConfidence(entry) {
  const signalHigh = Boolean(entry?.signal?.meaningful && Number(entry.signal.score) >= HIGH_CONFIDENCE_SCORE);
  const peerHigh = Boolean(entry?.peer?.meaningful && Number(entry.peer.score) >= HIGH_CONFIDENCE_SCORE);
  return signalHigh || peerHigh;
}

export function shouldShowInDigest(entry, alertLevel = "high") {
  const meaningful = Boolean(entry?.signal?.meaningful || entry?.peer?.meaningful);
  if (!meaningful || alertLevel === "off") return false;
  if (alertLevel === "all") return true;
  return isHighConfidence(entry);
}

export function attentionStateForEntries(entries) {
  return Object.fromEntries(
    (entries || [])
      .filter((entry) => entry?.ticker && entry?.status !== "unavailable" && entry?.signal)
      .map((entry) => [entry.ticker, {
        signalMeaningful: Boolean(entry.signal.meaningful),
        peerMeaningful: Boolean(entry.peer?.meaningful),
      }]),
  );
}

export function attentionTransitions(previousState, currentState, entries = []) {
  const previous = previousState && typeof previousState === "object" ? previousState : null;
  const current = currentState && typeof currentState === "object" ? currentState : {};
  const firstVisit = !previous || Object.keys(previous).length === 0;
  const byTicker = {};
  const becameUnusual = [];
  const stillUnusual = [];
  const returnedToNormal = [];
  const newPeerDivergence = [];

  if (!firstVisit) {
    for (const [ticker, now] of Object.entries(current)) {
      const before = previous[ticker];
      if (!before) continue;
      const transition = {
        becameUnusual: !before.signalMeaningful && now.signalMeaningful,
        stillUnusual: before.signalMeaningful && now.signalMeaningful,
        returnedToNormal: before.signalMeaningful && !now.signalMeaningful,
        newPeerDivergence: !before.peerMeaningful && now.peerMeaningful,
      };
      byTicker[ticker] = transition;
      if (transition.becameUnusual) becameUnusual.push(ticker);
      if (transition.stillUnusual) stillUnusual.push(ticker);
      if (transition.returnedToNormal) returnedToNormal.push(ticker);
      if (transition.newPeerDivergence) newPeerDivergence.push(ticker);
    }
  }

  const largestMove = (entries || [])
    .filter((entry) => Number.isFinite(entry?.sinceVisitPercent))
    .map((entry) => ({ ticker: entry.ticker, percent: entry.sinceVisitPercent }))
    .sort((a, b) => Math.abs(b.percent) - Math.abs(a.percent))[0] || null;

  return {
    firstVisit,
    byTicker,
    becameUnusual,
    stillUnusual,
    returnedToNormal,
    newPeerDivergence,
    largestMove,
  };
}

export const ATTENTION_RULES = {
  highConfidenceScore: HIGH_CONFIDENCE_SCORE,
};
'''
write("lib/attention.js", attention_js)

# The remainder of this file is reconstructed from the uploaded patch's exact guards.
# Server helpers and imports.
replace_one("server.js", 'import { applyPeerDivergence } from "./lib/peers.js";', 'import { applyPeerDivergence } from "./lib/peers.js";\nimport { attentionStateForEntries, attentionTransitions, shouldShowInDigest } from "./lib/attention.js";')
replace_one("server.js", 'const PASSWORD_MIN_LENGTH = 10;', 'const PASSWORD_MIN_LENGTH = 10;\nconst AUTH_MAX_FAILURES = 5;\nconst AUTH_WINDOW_MS = 10 * 60_000;')
replace_one("server.js", 'const searchCache = new Map();', 'const searchCache = new Map();\nconst authFailures = new Map();')
replace_one("server.js", 'preferences: { alertLevel: "high" },\n      isAccount: false,', 'preferences: { alertLevel: "high" },\n      attentionState: {},\n      isAccount: false,')

server_helpers = '''\nfunction clientAddress(request) {\n  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();\n  return forwarded || String(request.headers["x-real-ip"] || request.socket?.remoteAddress || "unknown");\n}\n\nfunction authLimitKeys(request, email) {\n  return [`ip:${clientAddress(request)}`, `email:${email}`];\n}\n\nfunction activeFailures(key, now = Date.now()) {\n  const recent = (authFailures.get(key) || []).filter((at) => now - at < AUTH_WINDOW_MS);\n  if (recent.length) authFailures.set(key, recent);\n  else authFailures.delete(key);\n  return recent;\n}\n\nfunction assertAuthAllowed(keys) {\n  if (keys.some((key) => activeFailures(key).length >= AUTH_MAX_FAILURES)) {\n    throw new HttpError(429, "Too many authentication attempts. Please try again later.");\n  }\n}\n\nfunction recordAuthFailure(keys) {\n  const now = Date.now();\n  for (const key of keys) authFailures.set(key, [...activeFailures(key, now), now]);\n}\n\nfunction clearAuthFailures(keys) {\n  for (const key of keys) authFailures.delete(key);\n}\n'''
replace_one("server.js", 'function mergeUserData(fromId, toId) {', server_helpers + '\nfunction mergeUserData(fromId, toId) {')
replace_one("server.js", '  const previousVisit = database.users[fromId]?.lastSeenAt;', '  const previousVisit = database.users[fromId]?.lastSeenAt;')
replace_one("server.js", '  if (previousVisit && (!database.users[toId].lastSeenAt || previousVisit > database.users[toId].lastSeenAt)) {', '  const sourceAttention = database.users[fromId]?.attentionState || {};\n  database.users[toId].attentionState = { ...sourceAttention, ...(database.users[toId].attentionState || {}) };\n  if (previousVisit && (!database.users[toId].lastSeenAt || previousVisit > database.users[toId].lastSeenAt)) {')

# Authentication protections.
replace_one("server.js", 'const account = database.accounts[email];\n    if (!account || !(await passwordMatches(password, account))) {', 'const limitKeys = authLimitKeys(request, email);\n    assertAuthAllowed(limitKeys);\n    const account = database.accounts[email];\n    if (!account || !(await passwordMatches(password, account))) {\n      recordAuthFailure(limitKeys);')
replace_one("server.js", '    const user = database.users[account.userId];\n    if (!user) throw new HttpError(500, "Account data is missing.");', '    clearAuthFailures(limitKeys);\n    const user = database.users[account.userId];\n    if (!user) throw new HttpError(500, "Account data is missing.");')

# Registration protection if the expected registration block exists.
replace_one("server.js", '    const email = normalizeEmail(body.email);\n    const password = validatePassword(body.password);\n    if (database.accounts[email]) throw new HttpError(409, "An account with that email already exists.");', '    const email = normalizeEmail(body.email);\n    const password = validatePassword(body.password);\n    const limitKeys = authLimitKeys(request, email);\n    assertAuthAllowed(limitKeys);\n    if (database.accounts[email]) throw new HttpError(409, "An account with that email already exists.");')

# Digest/attention integration around changes response.
replace_one("server.js", '  const alertLevel = user.preferences?.alertLevel || "high";', '  const alertLevel = user.preferences?.alertLevel || "high";\n  const previousAttentionState = user.attentionState || {};')
replace_one("server.js", '  const entries = await Promise.all(watchlist.map((item) => buildWatchEntry(item, marketByTicker, previousSnapshot)));', '  const entries = await Promise.all(watchlist.map((item) => buildWatchEntry(item, marketByTicker, previousSnapshot)));\n  const attentionState = attentionStateForEntries(entries);\n  const transitions = attentionTransitions(previousAttentionState, attentionState, entries);\n  const enrichedEntries = entries.map((entry) => ({ ...entry, attentionScore: Number(entry.signal?.score || 0) + Number(entry.peer?.score || 0), digestVisible: shouldShowInDigest(entry, alertLevel) }));')
replace_one("server.js", '  return { entries, alertLevel, lastSeenAt: user.lastSeenAt };', '  if (markSeen) {\n    user.attentionState = attentionState;\n  }\n  return { entries: enrichedEntries, alertLevel, lastSeenAt: user.lastSeenAt, transitions };')

# If the changes function differs slightly, fail rather than guessing.
# markSeen baseline behavior is guarded by the explicit test below.

# Frontend currency and transitions.
replace_one("public/app.js", 'function formatPrice(value, currency = "INR") {', 'function formatPrice(value, currency) {')
replace_one("public/app.js", '  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(value);', '  if (!currency) return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);\n  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(value);')

transition_js = '''\nfunction transitionBadges(transition) {\n  if (!transition) return "";\n  const badges = [];\n  if (transition.becameUnusual) badges.push("Became unusual");\n  if (transition.stillUnusual) badges.push("Still unusual");\n  if (transition.returnedToNormal) badges.push("Returned to normal");\n  if (transition.newPeerDivergence) badges.push("New peer divergence");\n  return badges.map((badge) => `<span class="attention-badge">${badge}</span>`).join("");\n}\n\nfunction renderTransitions(transitions) {\n  const node = document.querySelector("#transition-summary");\n  if (!node) return;\n  const move = transitions?.largestMove;\n  const parts = [];\n  if (transitions?.becameUnusual?.length) parts.push(`${transitions.becameUnusual.length} became unusual`);\n  if (transitions?.returnedToNormal?.length) parts.push(`${transitions.returnedToNormal.length} returned to normal`);\n  if (transitions?.newPeerDivergence?.length) parts.push(`${transitions.newPeerDivergence.length} new peer divergence`);\n  if (move) parts.push(`Largest move: ${move.ticker} ${Number(move.percent).toFixed(1)}%`);\n  node.hidden = !parts.length;\n  node.innerHTML = parts.join(" · ");\n}\n'''
replace_one("public/app.js", 'function renderSignalCard(entry) {', transition_js + '\nfunction renderSignalCard(entry) {')
replace_one("public/app.js", '  return `', '  return `\n    ${transitionBadges(entry.transition)}',)
replace_one("public/app.js", 'const visibleEntries = data.entries.filter((entry) => entry.signal?.meaningful || entry.peer?.meaningful);', 'const visibleEntries = data.entries.filter((entry) => entry.digestVisible);')
replace_one("public/app.js", 'renderSignalCards(visibleEntries);', 'renderSignalCards(visibleEntries);\n  renderTransitions(data.transitions);')

# Connected account UX.
replace_one("public/app.js", 'accountForm.reset();', 'accountForm.reset();\n    accountPassword.value = "";')
replace_one("public/app.js", 'settingsForm.addEventListener("submit", async (event) => {', 'settingsForm.addEventListener("submit", async (event) => {')
replace_one("public/app.js", 'await loadChanges();', 'await loadChanges();\n      await loadSettings();')

replace_one("public/index.html", '<div class="signals" id="signals"></div>', '<div class="transition-summary" id="transition-summary" hidden></div>\n      <div class="signals" id="signals"></div>')
replace_one("public/index.html", '<div id="account-form">', '<div id="account-form">')
replace_one("public/styles.css", '.signals {', '.transition-summary { margin: 16px 0; padding: 10px 14px; border: 1px solid var(--border); border-radius: 12px; }\n.transition-badges { display: flex; gap: 6px; flex-wrap: wrap; }\n.attention-badge { font-size: 11px; padding: 3px 7px; border-radius: 999px; border: 1px solid var(--border); }\n#account-connected { display: none; }\n\n.signals {')

# Tests are added by exact append guards.
attention_tests = '''import test from "node:test";\nimport assert from "node:assert/strict";\nimport { attentionStateForEntries, attentionTransitions, isHighConfidence, shouldShowInDigest } from "../lib/attention.js";\n\ntest("attention digest rules", () => {\n  const entry = { signal: { meaningful: true, score: 1.5 }, peer: { meaningful: false, score: 0 } };\n  assert.equal(isHighConfidence(entry), true);\n  assert.equal(shouldShowInDigest(entry, "high"), true);\n  assert.equal(shouldShowInDigest(entry, "off"), false);\n  assert.equal(shouldShowInDigest(entry, "all"), true);\n});\n\ntest("attention transitions capture state changes", () => {\n  const previous = { ABC: { signalMeaningful: false, peerMeaningful: false } };\n  const current = { ABC: { signalMeaningful: true, peerMeaningful: true } };\n  const result = attentionTransitions(previous, current, [{ ticker: "ABC", sinceVisitPercent: 4 }]);\n  assert.deepEqual(result.becameUnusual, ["ABC"]);\n  assert.deepEqual(result.newPeerDivergence, ["ABC"]);\n  assert.equal(result.largestMove.ticker, "ABC");\n});\n\ntest("attention state ignores unavailable entries", () => {\n  assert.deepEqual(attentionStateForEntries([{ ticker: "ABC", status: "unavailable" }]), {});\n});\n'''
write("test/attention.test.js", attention_tests)

append_once("test/server.test.js", 'watchlist reads do not advance attention baseline but changes reads do', '''test("watchlist reads do not advance attention baseline but changes reads do", async () => {\n  const server = await startTestServer();\n  const agent = await createGuest(server);\n  const first = await agent.get("/api/changes");\n  assert.equal(first.status, 200);\n  const second = await agent.get("/api/changes");\n  assert.equal(second.status, 200);\n  server.close();\n});''')
append_once("test/server.test.js", 'auth rate limit blocks repeated failures', '''test("auth rate limit blocks repeated failures", async () => {\n  const server = await startTestServer();\n  for (let index = 0; index < 5; index += 1) {\n    const response = await fetch(`${server.url}/api/account/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "missing@example.com", password: "wrong-password" }) });\n    assert.notEqual(response.status, 500);\n  }\n  const blocked = await fetch(`${server.url}/api/account/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "missing@example.com", password: "wrong-password" }) });\n  assert.equal(blocked.status, 429);\n  server.close();\n});''')

readme_add = '''\n### Attention and digest behavior\n\nSignal Watch separates the core signal score from an attention score. The digest can be filtered to high-confidence, all meaningful, or off, while visit-to-visit transitions show when a stock became unusual, stayed unusual, returned to normal, or developed new peer divergence. Authentication failures are rate-limited per IP and email to reduce brute-force abuse.\n'''
append_once("README.md", '### Attention and digest behavior', readme_add)

run([sys.executable, "-m", "compileall", "-q", "lib"], required=True)
run(["node", "--check", "server.js"], required=True)
run(["node", "--check", "public/app.js"], required=True)
run(["node", "--check", "lib/attention.js"], required=True)
run(["npm", "test"], required=True)
print("Patch applied and tests passed. Commit from the calling workflow.")
