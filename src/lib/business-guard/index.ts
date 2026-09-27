import type { BusinessResult } from "@/lib/business/types";
import type { PaymentAccount } from "@/lib/business-tools/types";

export type BusinessGuardCheckName =
  | "payment_account_whitelist"
  | "payment_account_identity"
  | "quantity_integrity"
  | "money_integrity"
  | "order_status_integrity"
  | "product_identity"
  | "draft_integrity"
  | "payment_verification"
  | "order_persistence"
  | "discount_authorization"
  | "delivery_certainty"
  | "fulfillment_capability"
  | "internal_language";

export type BusinessGuardCheck = {
  name: BusinessGuardCheckName;
  status: "pass" | "blocked" | "skipped";
  detail: string;
};

export type BusinessGuardResult = {
  allowed: boolean;
  checks: BusinessGuardCheck[];
  fallbackReason?: string;
};

const ACCOUNT_WINDOW_PATTERN = /(?:\d[\s.-]?){8,}/g;

/** Satuan yang mungkin muncul pada jawaban; dipakai untuk menemukan klaim jumlah. */
const UNIT_WORDS =
  "dus|dos|karton|krat|sak|zak|pcs|pc|pack|pak|box|bal|renceng|lusin|bungkus|sachet|saset|botol|kaleng|buah|biji|unit|slop|ikat|tray|papan|ml|cc|liter|l|gram|gr|kg";

const NEGATION_WINDOW = /(belum|tidak|nggak|gak|enggak|bukan|kurang|jangan)\s*$/i;

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function identityText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseIndonesianNumeric(raw: string) {
  const cleaned = raw.trim();

  if (/^\d{1,3}([.,]\d{3})+$/.test(cleaned)) {
    return Number(cleaned.replace(/[.,]/g, ""));
  }

  return Number(cleaned.replace(/\./g, "").replace(",", "."));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Menghapus nama produk dari teks supaya angka yang merupakan bagian identitas
 * varian (mis. "Aqua 600 ml") tidak dianggap klaim jumlah.
 */
function stripProductNames(response: string, result: BusinessResult) {
  const names = [
    result.requested.product_query,
    result.product?.name,
    ...result.candidates.map((product) => product.name),
    ...result.suggestions.map((product) => product.name),
    ...result.listed_products.map((product) => product.name),
    ...(result.draft?.items ?? []).map((item) => item.product_name),
    ...(result.draft?.cancelled_items ?? []).map((item) => item.product_name),
    ...result.operation_results.flatMap((operation) => [
      operation.product_name,
      operation.requested_query,
      ...operation.candidates,
    ]),
  ]
    .filter((name): name is string => Boolean(name))
    // Nama terpanjang dihapus lebih dulu; kalau "aqua" dihapus duluan,
    // "Aqua 600 ml" tidak lagi cocok dan "600 ml" salah dibaca sebagai jumlah.
    .sort((left, right) => right.length - left.length);

  return names.reduce(
    (text, name) => text.replace(new RegExp(escapeRegExp(name), "gi"), " "),
    response,
  );
}

function extractAccountLikeNumbers(response: string) {
  const numbers: string[] = [];
  const lower = response.toLowerCase();
  const keywords = /(rekening|rek\b|bank|transfer|pembayaran|bayar|nomor\s+akun|a\.n)/i;

  for (const match of response.matchAll(ACCOUNT_WINDOW_PATTERN)) {
    const raw = match[0];
    const normalized = digitsOnly(raw);
    const index = match.index ?? 0;
    const window = lower.slice(Math.max(0, index - 50), index + raw.length + 50);

    if (normalized.length >= 8 && keywords.test(window)) {
      numbers.push(normalized);
    }
  }

  return numbers;
}

function extractQuantityClaims(text: string) {
  const pattern = new RegExp(`(\\d[\\d.,]*)\\s*(?:${UNIT_WORDS})\\b`, "gi");
  return [...text.matchAll(pattern)].map((match) => parseIndonesianNumeric(match[1]));
}

function extractMoneyClaims(text: string) {
  const pattern = /rp\s?([\d][\d.,]*)/gi;
  return [...text.matchAll(pattern)].map((match) => parseIndonesianNumeric(match[1]));
}

function matchesWithoutNegation(response: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);

    for (const match of response.matchAll(global)) {
      const before = response.slice(Math.max(0, (match.index ?? 0) - 14), match.index ?? 0);
      if (!NEGATION_WINDOW.test(before)) {
        return match[0];
      }
    }
  }

  return null;
}

/**
 * Apakah response menyebut produk ini sebagai bagian pesanan (bukan sebagai
 * sesuatu yang dibatalkan).
 */
function claimsInclusion(response: string, productName: string) {
  const index = response.toLowerCase().indexOf(productName.toLowerCase());

  if (index === -1) {
    return false;
  }

  const window = response.slice(Math.max(0, index - 60), index + productName.length + 60);
  return !/(batal|dibatalkan|tidak jadi|nggak jadi|gak jadi|dikeluarkan|dihapus)/i.test(window);
}

function formatGuardQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function mentionsDraftItem(response: string, item: { product_name: string; quantity: number; unit: string }) {
  if (!claimsInclusion(response, item.product_name)) {
    return false;
  }

  const quantity = escapeRegExp(formatGuardQuantity(item.quantity));
  const unit = escapeRegExp(item.unit);
  return new RegExp(`\\b${quantity}\\s*${unit}\\b`, "i").test(response);
}

function allowedQuantities(result: BusinessResult) {
  const values = [
    result.availability?.quantity,
    result.maximum_available,
    result.requested.quantity,
    result.shortfall,
    ...result.operation_results.flatMap((operation) => [
      operation.requested_quantity,
      operation.applied_quantity,
      operation.stock_quantity,
    ]),
    ...(result.draft?.items ?? []).flatMap((item) => [
      item.quantity,
      item.stock_quantity,
      item.shortfall,
    ]),
  ];

  return new Set(
    values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
}

function allowedMoney(result: BusinessResult) {
  const values = [
    result.price,
    result.total,
    result.draft?.grand_total ?? null,
    ...result.listed_products.map((product) => product.price),
    ...result.operation_results.flatMap((operation) => [operation.price, operation.total]),
    ...(result.draft?.items ?? []).flatMap((item) => [item.unit_price, item.subtotal]),
  ];
  return new Set(
    values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
  );
}

const ORDER_ACCEPTED_PATTERNS = [
  /pesanan\s+(?:sudah|telah|berhasil)/i,
  /siap\s+(?:diproses|dikirim|kami\s+proses)/i,
  /(?:sudah|telah)\s+(?:saya|kami)\s+proses/i,
  /(?:bisa|dapat)\s+(?:dipenuhi|terpenuhi)\s+(?:semua|seluruhnya)/i,
];

const STOCK_SUFFICIENT_PATTERNS = [
  /stok(?:nya)?\s+(?:mencukupi|cukup|aman)/i,
  /(?:jumlah|qty|kuantitas)\s+(?:itu|tersebut)?\s*(?:masih\s+)?(?:aman|cukup|dalam stok)/i,
];

const ORDER_CREATED_PATTERNS = [
  /pesanan(?:nya)?\s+(?:sudah|telah|berhasil)\s+(?:\w+\s+)?(?:dibuat|tercatat|masuk|dibooking|diproses)/i,
  /order(?:an)?(?:nya)?\s+(?:sudah|telah|berhasil)\s+(?:\w+\s+)?(?:dibuat|tercatat|masuk|diproses)/i,
  /(?:sudah|telah)\s+(?:saya|kami)\s+(?:buatkan|masukkan\s+ke\s+sistem)/i,
];

/**
 * Belum ada integrasi verifikasi pembayaran, jadi bot tidak boleh pernah
 * menyatakan uangnya sudah diterima - berapa pun yakinnya customer.
 */
const PAYMENT_RECEIVED_PATTERNS = [
  /pembayaran(?:nya)?\s+(?:sudah|telah)\s+(?:kami\s+|saya\s+)?(?:terima|diterima|masuk|dikonfirmasi|terkonfirmasi)/i,
  /(?:transfer|pembayaran)(?:nya)?\s+(?:sudah|telah)\s+(?:kami\s+|saya\s+)?(?:cek|verifikasi|terverifikasi)/i,
  /dana(?:nya)?\s+(?:sudah|telah)\s+masuk/i,
  /(?:sudah|telah)\s+lunas/i,
];

const AVAILABILITY_PATTERNS = [/masih\s+ada/i, /masih\s+tersedia/i, /stok(?:nya)?\s+ada/i, /\bready\b/i];

const DELIVERY_PROMISE_PATTERNS = [
  /pasti\s+(?:sampai|tiba|datang|dikirim)/i,
  /dijamin\s+(?:sampai|tiba|datang)/i,
  /kami\s+jamin/i,
];

/**
 * COD, ambil sendiri, dan pengiriman belum punya sumber data. Menyatakan bisa
 * MAUPUN menyatakan tidak bisa sama-sama mengarang, jadi keduanya diblokir.
 */
const FULFILLMENT_CLAIM_PATTERNS = [
  /\b(?:bisa|dapat|melayani|menerima|tersedia|menyediakan)\s+(?:untuk\s+)?(?:cod|bayar\s+di\s+tempat|pickup|ambil\s+sendiri|ambil\s+di\s+tempat)/i,
  /\b(?:tidak|nggak|gak|belum|enggak)\s+(?:bisa|dapat|melayani|menerima|menyediakan)\s+(?:cod|bayar\s+di\s+tempat|pickup|ambil\s+sendiri|ambil\s+di\s+tempat)/i,
  /\b(?:cod|pickup)\s+(?:bisa|tersedia|tidak\s+tersedia|tidak\s+bisa)/i,
];

const INTERNAL_TERMS =
  /(GREETING_RESPONSE|THANKS_RESPONSE|PRODUCT_LISTED|INSUFFICIENT_STOCK|READY_FOR_CONFIRMATION|PRODUCT_NOT_FOUND|PRODUCT_AMBIGUOUS|NEEDS_CLARIFICATION|FUZZY_SAFE|DATA_UNAVAILABLE|QUOTE_CREATED|STOCK_AVAILABLE|business_result|order_allowed|supabase|gemini|business guard|tool call|confidence score)/i;

/**
 * Membandingkan kalimat kandidat dengan BusinessResult. Guard ini yang memastikan
 * bahasa boleh bervariasi tetapi fakta tidak.
 */
export function evaluateBusinessGuard(input: {
  response: string;
  businessResult: BusinessResult;
  officialPaymentAccounts: PaymentAccount[];
}): BusinessGuardResult {
  const { response, businessResult } = input;
  const checks: BusinessGuardCheck[] = [];
  const blockedReasons: BusinessGuardCheckName[] = [];

  function record(name: BusinessGuardCheckName, status: BusinessGuardCheck["status"], detail: string) {
    checks.push({ name, status, detail });
    if (status === "blocked") {
      blockedReasons.push(name);
    }
  }

  const officialAccountNumbers = new Set(
    input.officialPaymentAccounts.map((account) => digitsOnly(account.account_number)),
  );
  const officialAccountByNumber = new Map(
    input.officialPaymentAccounts.map((account) => [
      digitsOnly(account.account_number),
      account,
    ]),
  );
  const accountNumbers = extractAccountLikeNumbers(businessResult.persisted_order
    ? response.replaceAll(businessResult.persisted_order.order_number, "") : response);
  const unknownAccounts = accountNumbers.filter((number) => !officialAccountNumbers.has(number));
  const matchedAccounts = accountNumbers
    .map((number) => officialAccountByNumber.get(number))
    .filter((account): account is PaymentAccount => Boolean(account));

  if (accountNumbers.length === 0) {
    record("payment_account_whitelist", "skipped", "Tidak ada pola nomor rekening pada response.");
  } else if (unknownAccounts.length > 0) {
    record(
      "payment_account_whitelist",
      "blocked",
      `Nomor rekening tidak terdaftar: ${unknownAccounts.join(", ")}.`,
    );
  } else {
    record("payment_account_whitelist", "pass", "Semua nomor rekening ada di whitelist database.");
  }

  const responseIdentity = identityText(response);
  const mustMentionPaymentAccount =
    (businessResult.status === "PAYMENT_INSTRUCTIONS" ||
      businessResult.status === "PAYMENT_ACCOUNTS") &&
    businessResult.payment_accounts.length > 0;

  if (mustMentionPaymentAccount && accountNumbers.length === 0) {
    record(
      "payment_account_identity",
      "blocked",
      "Response pembayaran tidak menyebut nomor rekening resmi.",
    );
  } else if (matchedAccounts.length === 0) {
    record("payment_account_identity", "skipped", "Tidak ada rekening resmi yang disebut pada response.");
  } else {
    const missing = matchedAccounts.flatMap((account) => {
      const issues: string[] = [];

      if (!responseIdentity.includes(identityText(account.bank_name))) {
        issues.push(`bank ${account.bank_name}`);
      }

      if (!responseIdentity.includes(identityText(account.account_name))) {
        issues.push(`pemilik ${account.account_name}`);
      }

      return issues;
    });

    if (missing.length > 0) {
      record(
        "payment_account_identity",
        "blocked",
        `Identitas rekening resmi tidak lengkap/sesuai: ${missing.join(", ")}.`,
      );
    } else {
      record("payment_account_identity", "pass", "Bank, nomor rekening, dan pemilik rekening sesuai data resmi.");
    }
  }

  const withoutProductNames = stripProductNames(response, businessResult);
  const quantityClaims = extractQuantityClaims(withoutProductNames);
  const permittedQuantities = allowedQuantities(businessResult);
  const wrongQuantities = quantityClaims.filter((value) => !permittedQuantities.has(value));

  if (quantityClaims.length === 0) {
    record("quantity_integrity", "skipped", "Tidak ada klaim jumlah bersatuan pada response.");
  } else if (wrongQuantities.length > 0) {
    record(
      "quantity_integrity",
      "blocked",
      `Jumlah ${wrongQuantities.join(", ")} tidak ada pada hasil business engine (diizinkan: ${[...permittedQuantities].join(", ") || "tidak ada"}).`,
    );
  } else {
    record("quantity_integrity", "pass", "Semua angka jumlah berasal dari business result.");
  }

  const moneyClaims = extractMoneyClaims(response);
  const permittedMoney = allowedMoney(businessResult);
  const wrongMoney = moneyClaims.filter((value) => !permittedMoney.has(value));

  if (moneyClaims.length === 0) {
    record("money_integrity", "skipped", "Tidak ada nominal rupiah pada response.");
  } else if (wrongMoney.length > 0) {
    record(
      "money_integrity",
      "blocked",
      `Nominal ${wrongMoney.join(", ")} tidak ada pada hasil business engine (diizinkan: ${[...permittedMoney].join(", ") || "tidak ada"}).`,
    );
  } else {
    record("money_integrity", "pass", "Semua nominal berasal dari harga/total database.");
  }

  if (businessResult.order_allowed) {
    const created = matchesWithoutNegation(response, ORDER_CREATED_PATTERNS);
    if (created) {
      record(
        "order_status_integrity",
        "blocked",
        `Response menyatakan pesanan sudah dibuat ("${created}") padahal sistem baru sampai tahap konfirmasi.`,
      );
    } else {
      record("order_status_integrity", "pass", "Response tidak mengklaim pesanan sudah tercatat.");
    }
  } else {
    const accepted =
      matchesWithoutNegation(response, ORDER_ACCEPTED_PATTERNS) ??
      (businessResult.stock_sufficient === true
        ? null
        : matchesWithoutNegation(response, STOCK_SUFFICIENT_PATTERNS));
    if (accepted) {
      record(
        "order_status_integrity",
        "blocked",
        `Response menyatakan pesanan dapat diproses ("${accepted}") padahal order_allowed bernilai false.`,
      );
    } else {
      record("order_status_integrity", "pass", "Response tidak menyetujui transaksi yang belum valid.");
    }
  }

  if (
    businessResult.status === "PRODUCT_NOT_FOUND" ||
    businessResult.status === "PRODUCT_AMBIGUOUS"
  ) {
    const claimed = matchesWithoutNegation(response, AVAILABILITY_PATTERNS);
    if (claimed) {
      record(
        "product_identity",
        "blocked",
        `Produk belum dipastikan, tetapi response menyatakan ketersediaan ("${claimed}").`,
      );
    } else {
      record("product_identity", "pass", "Response tidak mengklaim ketersediaan produk yang belum pasti.");
    }
  } else {
    record("product_identity", "skipped", "Identitas produk sudah pasti dari product resolver.");
  }

  const discountApproval =
    /\b(diskon|disc|potongan|promo)\b/i.test(response) &&
    /\b(bisa|boleh|setuju|oke|ok|kami berikan|dapat)\b/i.test(response) &&
    !/\b(belum|tidak|nggak|gak|tidak bisa|belum punya|belum ada)\b/i.test(response);

  if (discountApproval) {
    record("discount_authorization", "blocked", "Response menyetujui diskon tanpa aturan diskon.");
  } else {
    record("discount_authorization", "skipped", "Tidak ada approval diskon eksplisit.");
  }

  if (businessResult.status === "DELIVERY_UNAVAILABLE") {
    const promise = matchesWithoutNegation(response, DELIVERY_PROMISE_PATTERNS);
    if (promise) {
      record("delivery_certainty", "blocked", `Response menjanjikan pengiriman ("${promise}").`);
    } else {
      record("delivery_certainty", "pass", "Response tidak menjanjikan kepastian pengiriman.");
    }
  } else {
    record("delivery_certainty", "skipped", "Bukan pertanyaan pengiriman.");
  }

  // Draft pesanan: barang yang dibatalkan tidak boleh muncul sebagai bagian
  // pesanan, dan barang aktif tidak boleh hilang diam-diam dari rangkuman.
  const cancelled = businessResult.draft?.cancelled_items ?? [];
  const activeNames = new Set((businessResult.draft?.items ?? []).map((item) => item.product_name));
  const wronglyIncluded = cancelled.filter(
    (item) => !activeNames.has(item.product_name) && claimsInclusion(response, item.product_name),
  );
  const missingActive = (businessResult.draft?.items ?? []).filter(
    (item) => !mentionsDraftItem(response, item),
  );

  if (!businessResult.draft) {
    record("draft_integrity", "skipped", "Tidak ada rangkuman draft pada hasil ini.");
  } else if (wronglyIncluded.length > 0) {
    record(
      "draft_integrity",
      "blocked",
      `Barang yang sudah dibatalkan disebut sebagai bagian pesanan: ${wronglyIncluded
        .map((item) => item.product_name)
        .join(", ")}.`,
    );
  } else if (missingActive.length > 0) {
    record(
      "draft_integrity",
      "blocked",
      `Barang aktif hilang dari rangkuman: ${missingActive
        .map((item) => `${item.product_name} ${item.quantity} ${item.unit}`)
        .join(", ")}.`,
    );
  } else {
    record("draft_integrity", "pass", "Isi rangkuman sesuai draft aktif.");
  }

  const paymentClaim = matchesWithoutNegation(response, PAYMENT_RECEIVED_PATTERNS);
  if (paymentClaim) {
    record(
      "payment_verification",
      "blocked",
      `Response menyatakan pembayaran sudah diterima ("${paymentClaim}") padahal tidak ada verifikasi pembayaran.`,
    );
  } else {
    record("payment_verification", "pass", "Response tidak mengklaim pembayaran terverifikasi.");
  }

  const persistenceClaim = matchesWithoutNegation(response, ORDER_CREATED_PATTERNS);
  if (persistenceClaim && !businessResult.persisted_order) {
    record(
      "order_persistence",
      "blocked",
      `Response menyatakan pesanan sudah tercatat ("${persistenceClaim}") padahal sistem belum menyimpan pesanan.`,
    );
  } else {
    record("order_persistence", "pass", "Response tidak mengklaim pesanan tersimpan di sistem.");
  }

  const fulfillmentClaim = FULFILLMENT_CLAIM_PATTERNS.map((pattern) =>
    response.match(pattern),
  ).find((match): match is RegExpMatchArray => Boolean(match));

  if (fulfillmentClaim) {
    record(
      "fulfillment_capability",
      "blocked",
      `Response memastikan layanan COD/pengambilan sendiri ("${fulfillmentClaim[0]}") padahal datanya belum ada di sistem.`,
    );
  } else {
    record("fulfillment_capability", "pass", "Response tidak memastikan layanan yang belum terdata.");
  }

  const internal = response.match(INTERNAL_TERMS);
  if (internal) {
    record("internal_language", "blocked", `Response membocorkan istilah internal "${internal[0]}".`);
  } else {
    record("internal_language", "pass", "Tidak ada istilah internal pada response.");
  }

  return {
    allowed: blockedReasons.length === 0,
    checks,
    fallbackReason: blockedReasons[0],
  };
}
