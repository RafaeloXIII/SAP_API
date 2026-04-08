function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildFlotationWidthVariants(widthRaw) {
  const normalized = String(widthRaw || "").trim();
  if (!normalized) return [];

  if (!normalized.includes(".")) {
    return [normalized];
  }

  const [whole, fraction = ""] = normalized.split(".");
  const fixed = `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
  const trimmedFraction = fraction.replace(/0+$/, "");
  const trimmed = trimmedFraction ? `${whole}.${trimmedFraction}` : whole;

  return unique([fixed, trimmed]);
}

export function parseTireSearch(value) {
  const compact = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/,/g, ".")
    .replace(/["'\s]+/g, "");

  if (!compact) return null;

  const metric = compact.match(/^(\d{3})\/?(\d{2,3})R?(\d{2})$/);
  if (metric) {
    const [, width, profile, aro] = metric;
    return {
      type: "metric",
      aro,
      medida: `${width}/${profile}`,
      searchPatterns: [`${width}${profile}R${aro}`],
    };
  }

  const flotation = compact.match(/^(\d{2,3})[X/](\d{1,2}(?:\.\d{1,2})?)R?(\d{2})$/);
  if (flotation) {
    const [, diameter, widthRaw, aro] = flotation;
    const widthVariants = buildFlotationWidthVariants(widthRaw);
    const searchPatterns = widthVariants.map((width) => `${diameter}X${width.replace(".", "")}R${aro}`);

    return {
      type: "flotation",
      aro,
      medida: `${diameter}X${widthVariants[0] || widthRaw}`,
      searchPatterns: unique(searchPatterns),
    };
  }

  return null;
}
