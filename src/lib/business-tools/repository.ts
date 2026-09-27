import { getSupabaseSecretKey, getSupabaseUrl } from "@/lib/config";
import { SupabaseBusinessRepository } from "./supabase-repository";
import type { BusinessRepository } from "./types";

let cachedSupabaseRepository: BusinessRepository | undefined;

export function getBusinessRepository(): BusinessRepository {
  if (!getSupabaseUrl() || !getSupabaseSecretKey()) {
    throw new Error(
      "Supabase server configuration is missing. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.",
    );
  }

  cachedSupabaseRepository ??= new SupabaseBusinessRepository();
  return cachedSupabaseRepository;
}
