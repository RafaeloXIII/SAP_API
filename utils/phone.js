export function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function buildPhoneLookupCandidates(value) {
  const digits = normalizePhoneDigits(value);
  const candidates = [digits];

  if (digits.startsWith("55") && digits.length > 11) {
    candidates.push(digits.slice(2));
  }

  if (digits.length > 11) {
    candidates.push(digits.slice(-11));
  }

  if (digits.length > 10) {
    candidates.push(digits.slice(-10));
  }

  return [...new Set(candidates.filter((candidate) => candidate.length >= 8))];
}

export function maskPhone(value) {
  const digits = normalizePhoneDigits(value);
  if (!digits) return value;

  if (digits.length <= 4) {
    return `***${digits}`;
  }

  return `***${digits.slice(-4)}`;
}
