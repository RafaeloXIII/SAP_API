export function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function addCandidate(target, value) {
  const digits = normalizePhoneDigits(value);
  if (digits.length >= 8) {
    target.add(digits);
  }
}

function expandBrazilianMobileNineDigit(target, digits) {
  if (digits.length === 10) {
    addCandidate(target, `${digits.slice(0, 2)}9${digits.slice(2)}`);
  }

  if (digits.length === 11 && digits[2] === "9") {
    addCandidate(target, `${digits.slice(0, 2)}${digits.slice(3)}`);
  }
}

export function buildPhoneLookupCandidates(value) {
  const digits = normalizePhoneDigits(value);
  const candidates = new Set();
  const localCandidates = new Set();
  const localBase = digits.startsWith("55") && digits.length > 10 ? digits.slice(2) : digits;

  addCandidate(candidates, digits);
  addCandidate(localCandidates, localBase);

  if (localBase.length >= 11) {
    addCandidate(localCandidates, localBase.slice(-11));
  }

  if (localBase.length >= 10) {
    addCandidate(localCandidates, localBase.slice(-10));
  }

  for (const candidate of localCandidates) {
    addCandidate(candidates, candidate);
    expandBrazilianMobileNineDigit(candidates, candidate);

    if (!candidate.startsWith("55")) {
      addCandidate(candidates, `55${candidate}`);

      const prefixedVariants = new Set();
      expandBrazilianMobileNineDigit(prefixedVariants, candidate);
      for (const variant of prefixedVariants) {
        addCandidate(candidates, `55${variant}`);
      }
    }
  }

  return [...candidates];
}

export function maskPhone(value) {
  const digits = normalizePhoneDigits(value);
  if (!digits) return value;

  if (digits.length <= 4) {
    return `***${digits}`;
  }

  return `***${digits.slice(-4)}`;
}
