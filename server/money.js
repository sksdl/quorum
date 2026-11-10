// All money in Quorum is handled as integer cents (USD) or whole won (KRW).
// Floats only appear when converting between the two for cost estimates.

export function toCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Bad money value: ${value}`);
    return Math.round(value * 100);
  }
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Bad money value: "${value}"`);
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

// "9.00" style string for PayPal amount objects.
export function toValue(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Bad cents value: ${cents}`);
  return (cents / 100).toFixed(2);
}

export function usdAmount(cents) {
  return { currency_code: 'USD', value: toValue(cents) };
}

export function fmtUsd(cents) {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtKrw(won) {
  return `₩${Math.round(won).toLocaleString('en-US')}`;
}
