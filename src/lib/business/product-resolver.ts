import type { Product, PublicProduct } from "@/lib/business-tools/types";
import type {
  ProductCandidate,
  ProductMatchReason,
  ProductMatchType,
  ProductResolution,
  ProductResolutionStatus,
  SizeSpec,
} from "./types";

const SIZE_UNITS = new Map<string, { dimension: SizeSpec["dimension"]; factor: number }>([
  ["ml", { dimension: "volume", factor: 1 }],
  ["mililiter", { dimension: "volume", factor: 1 }],
  ["cc", { dimension: "volume", factor: 1 }],
  ["l", { dimension: "volume", factor: 1000 }],
  ["lt", { dimension: "volume", factor: 1000 }],
  ["ltr", { dimension: "volume", factor: 1000 }],
  ["liter", { dimension: "volume", factor: 1000 }],
  ["litre", { dimension: "volume", factor: 1000 }],
  ["g", { dimension: "mass", factor: 1 }],
  ["gr", { dimension: "mass", factor: 1 }],
  ["gram", { dimension: "mass", factor: 1 }],
  ["kg", { dimension: "mass", factor: 1000 }],
  ["kilo", { dimension: "mass", factor: 1000 }],
  ["kilogram", { dimension: "mass", factor: 1000 }],
]);

const PACKAGING_TOKENS = new Set([
  "dus",
  "karton",
  "krat",
  "sak",
  "pcs",
  "pc",
  "pack",
  "pak",
  "box",
  "bal",
  "renceng",
  "lusin",
  "bungkus",
  "sachet",
  "saset",
]);

const FILLER_TOKENS = new Set(["per", "dan", "untuk", "isi", "kemasan"]);

const MAX_RESULTS = 5;

function baseLower(value: string) {
  // NFKD memisahkan diakritik; tokenizer di bawah hanya mengambil [a-z0-9] sehingga sisa mark diabaikan.
  return value.toLowerCase().normalize("NFKD");
}

/**
 * Tokenisasi yang mempertahankan angka desimal ("1,5" dan "1.5" tetap "1.5")
 * supaya ukuran varian seperti "1.5 liter" tidak pecah menjadi dua angka.
 */
export function tokenize(value: string): string[] {
  const matches = baseLower(value).match(/\d+(?:[.,]\d+)?|[a-z]+/g) ?? [];
  return matches.map((token) => token.replace(",", "."));
}

export function normalizeText(value: string) {
  return tokenize(value).join(" ");
}

export function isNumericToken(token: string) {
  return /^\d+(?:\.\d+)?$/.test(token);
}

export function isSizeUnitToken(token: string) {
  return SIZE_UNITS.has(token);
}

export function isPackagingToken(token: string) {
  return PACKAGING_TOKENS.has(token);
}

type TokenProfile = {
  descriptive: string[];
  sizes: SizeSpec[];
};

/**
 * Memisahkan teks menjadi token deskriptif (brand + varian) dan spesifikasi ukuran.
 * Satuan, kemasan, dan angka tanpa satuan dibuang dari kedua sisi supaya
 * perbandingan query dengan nama produk simetris.
 */
function profileText(value: string): TokenProfile {
  const tokens = tokenize(value);
  const descriptive: string[] = [];
  const sizes: SizeSpec[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (isNumericToken(token)) {
      const unit = SIZE_UNITS.get(tokens[index + 1] ?? "");
      if (unit) {
        sizes.push({ dimension: unit.dimension, value: Number(token) * unit.factor });
        index += 1;
      }
      continue;
    }

    if (
      token.length < 2 ||
      SIZE_UNITS.has(token) ||
      PACKAGING_TOKENS.has(token) ||
      FILLER_TOKENS.has(token)
    ) {
      continue;
    }

    descriptive.push(token);
  }

  return { descriptive, sizes };
}

function levenshtein(a: string, b: string) {
  const matrix = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }

  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

function typoTolerance(length: number) {
  if (length <= 3) {
    return 0;
  }

  if (length <= 7) {
    return 1;
  }

  return 2;
}

type TokenMatch = {
  token: string;
  matched: string;
  kind: "exact" | "prefix" | "typo";
  score: number;
};

/**
 * Mencocokkan satu token query ke token produk. Hanya typo ringan yang
 * ditoleransi: huruf pertama wajib sama dan jarak edit dibatasi panjang token,
 * sehingga varian berbeda ("soto" vs "goreng") tidak pernah dianggap sama.
 */
function matchToken(queryToken: string, productTokens: string[]): TokenMatch | null {
  if (productTokens.includes(queryToken)) {
    return { token: queryToken, matched: queryToken, kind: "exact", score: 1 };
  }

  const tolerance = typoTolerance(queryToken.length);
  let best: TokenMatch | null = null;

  for (const candidate of productTokens) {
    if (queryToken.length >= 4 && candidate.startsWith(queryToken)) {
      if (!best || best.score < 0.9) {
        best = { token: queryToken, matched: candidate, kind: "prefix", score: 0.9 };
      }
      continue;
    }

    if (tolerance === 0 || candidate[0] !== queryToken[0]) {
      continue;
    }

    if (Math.abs(candidate.length - queryToken.length) > tolerance) {
      continue;
    }

    const distance = levenshtein(queryToken, candidate);
    if (distance === 0 || distance > tolerance) {
      continue;
    }

    const score = distance === 1 ? 0.85 : 0.72;
    if (!best || best.score < score) {
      best = { token: queryToken, matched: candidate, kind: "typo", score };
    }
  }

  return best;
}

type ProductProfile = {
  product: Product;
  primary: string[];
  secondary: string[];
  sizes: SizeSpec[];
  normalizedName: string;
  normalizedSku: string;
};

function profileProduct(product: Product): ProductProfile {
  const name = profileText(product.name);
  const description = profileText(product.description ?? "");

  return {
    product,
    primary: name.descriptive,
    secondary: description.descriptive,
    sizes: [...name.sizes, ...description.sizes],
    normalizedName: normalizeText(product.name),
    normalizedSku: normalizeText(product.sku),
  };
}

type SizeStatus = "ok" | "mismatch" | "unverified" | "no_size_in_query";

function compareSizes(query: SizeSpec[], product: SizeSpec[]): SizeStatus {
  if (query.length === 0) {
    return "no_size_in_query";
  }

  for (const size of query) {
    const sameDimension = product.filter((item) => item.dimension === size.dimension);

    if (sameDimension.length === 0) {
      return "unverified";
    }

    if (!sameDimension.some((item) => Math.abs(item.value - size.value) < 0.001)) {
      return "mismatch";
    }
  }

  return "ok";
}

type Evaluation = {
  profile: ProductProfile;
  matches: TokenMatch[];
  unmatched: string[];
  sizeStatus: SizeStatus;
  exactIdentity: boolean;
  confidence: number;
  reason: ProductMatchReason;
};

function evaluateProduct(
  profile: ProductProfile,
  query: TokenProfile,
  normalizedQuery: string,
): Evaluation {
  const matches: TokenMatch[] = [];
  const unmatched: string[] = [];

  for (const token of query.descriptive) {
    const primary = matchToken(token, profile.primary);
    if (primary) {
      matches.push(primary);
      continue;
    }

    const secondary = matchToken(token, profile.secondary);
    if (secondary) {
      matches.push({ ...secondary, score: Math.min(secondary.score, 0.6) });
      continue;
    }

    unmatched.push(token);
  }

  const sizeStatus = compareSizes(query.sizes, profile.sizes);
  const identityBySku = Boolean(profile.normalizedSku) && profile.normalizedSku === normalizedQuery;
  const coversAllProductTokens =
    profile.primary.every((token) => query.descriptive.includes(token)) &&
    profile.sizes.length === query.sizes.length;
  const allExact = matches.every((match) => match.kind === "exact");
  const exactIdentity =
    identityBySku ||
    profile.normalizedName === normalizedQuery ||
    (unmatched.length === 0 &&
      allExact &&
      coversAllProductTokens &&
      (sizeStatus === "ok" || (sizeStatus === "no_size_in_query" && profile.sizes.length === 0)));

  const averageScore =
    matches.length > 0
      ? matches.reduce((total, match) => total + match.score, 0) / matches.length
      : 0;
  const productHasExtraTokens = profile.primary.some((token) => !query.descriptive.includes(token));

  let reason: ProductMatchReason;
  if (unmatched.length > 0) {
    reason = "variant_mismatch";
  } else if (sizeStatus === "mismatch") {
    reason = "size_mismatch";
  } else if (sizeStatus === "unverified") {
    reason = "size_unverified";
  } else if (identityBySku) {
    reason = "exact_sku";
  } else if (exactIdentity) {
    reason = "exact_name";
  } else if (!allExact) {
    reason = "typo_tolerated";
  } else if (productHasExtraTokens || profile.sizes.length > query.sizes.length) {
    reason = "partial_variant";
  } else {
    reason = "all_tokens_exact";
  }

  let confidence = 0;
  if (unmatched.length === 0 && (sizeStatus === "ok" || sizeStatus === "no_size_in_query")) {
    confidence = exactIdentity ? 1 : averageScore * (productHasExtraTokens ? 0.9 : 1);
  } else if (query.descriptive.length > 0) {
    confidence = matches.length / query.descriptive.length;
  }

  return {
    profile,
    matches,
    unmatched,
    sizeStatus,
    exactIdentity,
    confidence: Number(confidence.toFixed(3)),
    reason,
  };
}

export function toPublicProduct(product: Product): PublicProduct {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    unit: product.unit,
  };
}

function toCandidate(evaluation: Evaluation): ProductCandidate {
  return {
    product: toPublicProduct(evaluation.profile.product),
    confidence: evaluation.confidence,
    reason: evaluation.reason,
    matched_tokens: evaluation.matches.map((match) => match.token),
    unmatched_tokens: [...evaluation.unmatched],
  };
}

function byConfidence(left: ProductCandidate, right: ProductCandidate) {
  if (right.confidence !== left.confidence) {
    return right.confidence - left.confidence;
  }

  return left.product.name.localeCompare(right.product.name);
}

const MATCH_TYPE_BY_STATUS: Record<ProductResolutionStatus, ProductMatchType> = {
  EXACT: "exact",
  FUZZY_SAFE: "fuzzy",
  AMBIGUOUS: "ambiguous",
  NOT_FOUND: "none",
};

function build(
  status: ProductResolutionStatus,
  requestedQuery: string,
  normalizedQuery: string,
  parts: {
    product?: PublicProduct | null;
    candidates?: ProductCandidate[];
    suggestions?: ProductCandidate[];
    confidence?: number;
    reason: string;
  },
): ProductResolution {
  return {
    status,
    match_type: MATCH_TYPE_BY_STATUS[status],
    requested_query: requestedQuery,
    normalized_query: normalizedQuery,
    product: parts.product ?? null,
    candidates: parts.candidates ?? [],
    suggestions: parts.suggestions ?? [],
    confidence: parts.confidence ?? 0,
    reason: parts.reason,
  };
}

/**
 * Product resolution deterministik dan generik: berlaku untuk seluruh katalog
 * tanpa aturan khusus per produk. Token varian dan ukuran bersifat signifikan,
 * sehingga produk dengan varian berbeda tidak pernah saling menggantikan.
 */
export function resolveProductQuery(
  products: Product[],
  rawQuery: string,
  options: { restrictToProductIds?: string[] } = {},
): ProductResolution {
  const restrictSet = options.restrictToProductIds?.length
    ? new Set(options.restrictToProductIds)
    : undefined;

  const activeProducts = products.filter(
    (product) => product.active && (!restrictSet || restrictSet.has(product.id)),
  );

  const requestedQuery = rawQuery.trim();
  const normalizedQuery = normalizeText(requestedQuery);
  const query = profileText(requestedQuery);

  if (query.descriptive.length === 0 && query.sizes.length === 0) {
    return build("NOT_FOUND", requestedQuery, normalizedQuery, {
      suggestions: activeProducts.slice(0, MAX_RESULTS).map((product) => ({
        product: toPublicProduct(product),
        confidence: 0,
        reason: "empty_query" as const,
        matched_tokens: [],
        unmatched_tokens: [],
      })),
      reason: "Customer belum menyebut produk apa pun sehingga tidak ada yang bisa di-resolve.",
    });
  }

  // SKU adalah identitas tunggal: kalau customer menyebutnya persis, tidak perlu
  // pencocokan token sama sekali.
  const bySku = activeProducts.find((product) => normalizeText(product.sku) === normalizedQuery);
  if (bySku) {
    const candidate: ProductCandidate = {
      product: toPublicProduct(bySku),
      confidence: 1,
      reason: "exact_sku",
      matched_tokens: [normalizedQuery],
      unmatched_tokens: [],
    };

    return build("EXACT", requestedQuery, normalizedQuery, {
      product: candidate.product,
      candidates: [candidate],
      confidence: 1,
      reason: `SKU "${bySku.sku}" cocok persis dengan ${bySku.name}.`,
    });
  }

  const evaluations = activeProducts.map((product) =>
    evaluateProduct(profileProduct(product), query, normalizedQuery),
  );

  const qualified = evaluations.filter(
    (evaluation) =>
      evaluation.unmatched.length === 0 &&
      (evaluation.sizeStatus === "ok" || evaluation.sizeStatus === "no_size_in_query"),
  );

  if (qualified.length === 0) {
    const firstToken = query.descriptive[0];
    const suggestions = evaluations
      .filter((evaluation) => {
        if (evaluation.matches.length === 0) {
          return false;
        }

        const ratio = evaluation.matches.length / Math.max(1, query.descriptive.length);
        return (
          ratio >= 0.5 ||
          (firstToken ? evaluation.matches.some((match) => match.token === firstToken) : false)
        );
      })
      .map(toCandidate)
      .sort(byConfidence)
      .slice(0, MAX_RESULTS);

    return build("NOT_FOUND", requestedQuery, normalizedQuery, {
      suggestions,
      reason: suggestions.length
        ? `Tidak ada produk yang cocok dengan "${normalizedQuery}"; ${suggestions.length} produk mirip ditemukan tetapi variannya berbeda.`
        : `Tidak ada produk yang cocok dengan "${normalizedQuery}" di katalog aktif.`,
    });
  }

  const sorted = [...qualified].sort((left, right) => right.confidence - left.confidence);
  const identical = sorted.filter((evaluation) => evaluation.exactIdentity);

  if (sorted.length === 1 || identical.length === 1) {
    const winner = identical.length === 1 ? identical[0] : sorted[0];
    const candidate = toCandidate(winner);

    return build(winner.exactIdentity ? "EXACT" : "FUZZY_SAFE", requestedQuery, normalizedQuery, {
      product: candidate.product,
      candidates: [candidate],
      confidence: candidate.confidence,
      reason: winner.exactIdentity
        ? `"${normalizedQuery}" cocok persis dengan ${winner.profile.product.name}.`
        : `"${normalizedQuery}" diarahkan ke ${winner.profile.product.name} (${candidate.reason}, confidence ${candidate.confidence}).`,
    });
  }

  const candidates = sorted.map(toCandidate).sort(byConfidence).slice(0, MAX_RESULTS);

  return build("AMBIGUOUS", requestedQuery, normalizedQuery, {
    candidates,
    reason: `"${normalizedQuery}" cocok dengan ${candidates.length} varian sehingga harus dikonfirmasi ke customer.`,
  });
}

/**
 * Resolusi dari konteks percakapan: produk sudah pernah dipastikan sebelumnya,
 * jadi identitasnya tidak perlu ditebak lagi. Fakta bisnisnya tetap diambil ulang
 * dari database oleh business engine.
 */
export function resolutionFromContext(product: Product, requestedQuery: string): ProductResolution {
  return build("EXACT", requestedQuery, normalizeText(product.name), {
    product: toPublicProduct(product),
    candidates: [
      {
        product: toPublicProduct(product),
        confidence: 1,
        reason: "context_reference",
        matched_tokens: [],
        unmatched_tokens: [],
      },
    ],
    confidence: 1,
    reason: `Produk diambil dari konteks percakapan sebelumnya (${product.name}).`,
  });
}
