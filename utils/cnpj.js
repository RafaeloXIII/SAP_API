export function normalizeCNPJNumeric(value) {
  return String(value || '').replace(/\D/g, '');
}

export function formatCNPJMask(digits) {
  const d = normalizeCNPJNumeric(digits);
  if (d.length !== 14) return null;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}