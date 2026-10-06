// Синтетичний приклад для native review spike, без приватних даних.
export function discountTotal(amount, percent) {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError('amount must be a finite non-negative number');
  }
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError('percent must be between 0 and 100');
  }
  return amount * (1 - percent / 100);
}
