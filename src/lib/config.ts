/**
 * gemini-2.5-flash-lite sudah tidak dilayani lagi (404), dan kegagalannya
 * membuat seluruh pemahaman bahasa diam-diam jatuh ke parser deterministik.
 * Model bisa ditimpa lewat env GEMINI_MODEL.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const LOCAL_SEED_COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: string, envName: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${envName} must be a valid UUID.`);
  }

  return value;
}

export function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY?.trim() || undefined;
}

export function getGeminiModel() {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

export function getSupabaseUrl() {
  return process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || undefined;
}

export function getSupabaseSecretKey() {
  return (
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    undefined
  );
}

export function getDefaultCompanyId() {
  const value = process.env.DEFAULT_COMPANY_ID?.trim() || LOCAL_SEED_COMPANY_ID;
  return requireUuid(value, "DEFAULT_COMPANY_ID");
}

export function getAdminApiToken() {
  return process.env.ADMIN_API_TOKEN?.trim() || undefined;
}
