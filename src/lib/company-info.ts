import type { PrismaClient } from '@/generated/tenant';
import {
  SETTING_KEYS,
  companyInfoValueSchema,
  type CompanyInfoOnDisk,
} from '@/lib/validation/settings';
import { getSetting } from '@/server/services/settings';

// =============================================================================
// Per-tenant company info — sourced from the `company_info` admin Setting.
//
// Configured in Admin → Settings; read at the document boundary via
// getCompanyInfo(db). A freshly provisioned instance that hasn't saved the
// setting yet falls back to a stable default (with a "Set company name in
// Admin → Settings" hint) so documents still render.
//
// Previously env-backed (COMPANY_NAME etc.); that dependency is removed —
// the setting is the single source of truth.
// =============================================================================

export type CompanyInfo = {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  // Optional path-relative URL (e.g. "/logo.png") OR full URL. Renders
  // as an <img> when set; the document falls back to text-only branding
  // when null.
  logoUrl: string | null;
};

const FALLBACK_NAME = 'Set company name in Admin → Settings';

export async function getCompanyInfo(db: PrismaClient): Promise<CompanyInfo> {
  let stored: CompanyInfoOnDisk | null = null;
  try {
    stored = await getSetting(
      db,
      SETTING_KEYS.COMPANY_INFO,
      companyInfoValueSchema,
    );
  } catch {
    // Row missing (not configured yet) or corrupt — fall back to defaults
    // so documents always render. The schema already trims/normalizes
    // empty fields to null when present.
    stored = null;
  }

  return {
    name: stored?.name ?? FALLBACK_NAME,
    addressLine1: stored?.addressLine1 ?? null,
    addressLine2: stored?.addressLine2 ?? null,
    city: stored?.city ?? null,
    region: stored?.region ?? null,
    postalCode: stored?.postalCode ?? null,
    country: stored?.country ?? null,
    phone: stored?.phone ?? null,
    email: stored?.email ?? null,
    logoUrl: stored?.logoUrl ?? null,
  };
}
