export function displayTicker(symbol) {
  const value = String(symbol || "").trim();
  if (!value) return "";
  return value.replace(/\.(NS|BO)$/i, "");
}

export function displayTickerMessage(message) {
  return String(message || "").replace(/\b[A-Z0-9-]+\.(?:NS|BO)\b/gi, (ticker) => displayTicker(ticker));
}
