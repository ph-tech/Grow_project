const INDIAN_MARKET_TIMEZONE = "Asia/Kolkata";
const INDIAN_MARKET_OPEN_MINUTES = 9 * 60 + 15;
const INDIAN_MARKET_CLOSE_MINUTES = 15 * 60 + 30;

function istWeekdayAndMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: INDIAN_MARKET_TIMEZONE,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { weekday: map.weekday, minutesOfDay: Number(map.hour) * 60 + Number(map.minute) };
}

export function isIndianTicker(ticker, exchangeCode, exchangeTimezone) {
  const normalizedTicker = String(ticker || "").toUpperCase();
  if (/\.(NS|BO)$/.test(normalizedTicker)) return true;
  if (["NSI", "BSE"].includes(String(exchangeCode || "").toUpperCase())) return true;
  return exchangeTimezone === "Asia/Kolkata" || exchangeTimezone === "Asia/Calcutta";
}

export function isIndianMarketOpen(date = new Date()) {
  const { weekday, minutesOfDay } = istWeekdayAndMinutes(date);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return minutesOfDay >= INDIAN_MARKET_OPEN_MINUTES && minutesOfDay <= INDIAN_MARKET_CLOSE_MINUTES;
}

export function istCalendarDate(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: INDIAN_MARKET_TIMEZONE }).format(date);
}

export function freshnessStatus(providerAt, market = {}, now = new Date()) {
  const quotedAt = new Date(providerAt).getTime();
  if (!Number.isFinite(quotedAt)) return { ageMinutes: null, stale: true, marketClosed: false, label: "Quote time unavailable" };
  const ageMinutes = Math.max(0, Math.round((now.getTime() - quotedAt) / 60_000));
  const isIndian = isIndianTicker(market.ticker, market.exchangeCode, market.exchangeTimezone);
  if (isIndian && !isIndianMarketOpen(now)) {
    const sameTradingDay = istCalendarDate(new Date(quotedAt)) === istCalendarDate(now);
    return {
      ageMinutes,
      stale: false,
      marketClosed: true,
      label: sameTradingDay ? "Market closed" : "Last session data",
    };
  }
  return { ageMinutes, stale: ageMinutes > 20, marketClosed: false, label: ageMinutes <= 1 ? "Just updated" : `${ageMinutes}m old` };
}
