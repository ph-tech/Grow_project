const VOLATILITY_FLOOR = 0.25;

export function standardDeviation(values) {
  const samples = values.filter(Number.isFinite);
  if (samples.length < 2) return 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  // Daily returns are a sample of the stock's underlying volatility, so use sample stdev.
  return Math.sqrt(
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1),
  );
}

export function calculateSignal({ price, previousClose, volume, history }) {
  const completed = (Array.isArray(history) ? history : [])
    .map((day) => ({ close: Number(day?.close), volume: Number(day?.volume) || 0 }))
    .filter((day) => Number.isFinite(day.close) && day.close > 0)
    .slice(-30);
  const returns = completed
    .slice(1)
    .map((day, index) => ((day.close - completed[index].close) / completed[index].close) * 100);
  const volatility = Math.max(standardDeviation(returns.slice(-20)), VOLATILITY_FLOOR);
  const averageVolume =
    completed.slice(-20).reduce((sum, day) => sum + (day.volume || 0), 0) /
    Math.max(completed.slice(-20).filter((day) => day.volume > 0).length, 1);
  const latestPrice = Number(price);
  const priorClose = Number(previousClose);
  const latestVolume = Number(volume);
  const changePercent =
    Number.isFinite(latestPrice) && latestPrice > 0 && Number.isFinite(priorClose) && priorClose > 0
      ? ((latestPrice - priorClose) / priorClose) * 100
      : 0;
  const rangeMultiple = Math.abs(changePercent) / volatility;
  const volumeRatio = averageVolume > 0 && Number.isFinite(latestVolume) && latestVolume > 0 ? latestVolume / averageVolume : null;
  const volumeBoost = volumeRatio && volumeRatio > 1 ? Math.min(Math.log2(volumeRatio), 2) * 0.35 : 0;
  const score = rangeMultiple * (1 + volumeBoost);
  const meaningful = rangeMultiple >= 1.25 || (rangeMultiple >= 0.9 && (volumeRatio || 0) >= 2);

  return {
    averageVolume,
    changePercent,
    meaningful,
    rangeMultiple,
    score,
    volatility,
    volumeRatio,
  };
}

export function explainSignal(signal) {
  const direction = signal.changePercent >= 0 ? "Up" : "Down";
  const movement = `${direction} ${Math.abs(signal.changePercent).toFixed(2)}%`;
  const range = `${signal.rangeMultiple.toFixed(1)}x its usual daily swing`;
  const volume = signal.volumeRatio
    ? ` on ${signal.volumeRatio.toFixed(1)}x average volume`
    : " with volume unavailable";
  return `${movement} - ${range}${volume}.`;
}
