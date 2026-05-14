// =============================================================================
// Per-tenant company info — sourced from env vars for the pilot. Each
// deployed instance reads its own .env so company name / address /
// contact info live with the tenant they describe. A follow-up phase
// can move this into a Setting row for in-app editing without touching
// any caller — only this helper changes.
//
// Every field defaults to a stable sentinel so a freshly provisioned
// instance that hasn't set its env yet still renders documents
// (with "Configure company info in .env" hints in the right spots).
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

const FALLBACK_NAME = 'Configure COMPANY_NAME in .env';

function trim(v: string | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  return s === '' ? null : s;
}

export function getCompanyInfo(): CompanyInfo {
  return {
    name: trim(process.env.COMPANY_NAME) ?? FALLBACK_NAME,
    addressLine1: trim(process.env.COMPANY_ADDRESS_LINE1),
    addressLine2: trim(process.env.COMPANY_ADDRESS_LINE2),
    city: trim(process.env.COMPANY_CITY),
    region: trim(process.env.COMPANY_REGION),
    postalCode: trim(process.env.COMPANY_POSTAL),
    country: trim(process.env.COMPANY_COUNTRY),
    phone: trim(process.env.COMPANY_PHONE),
    email: trim(process.env.COMPANY_EMAIL),
    logoUrl: trim(process.env.COMPANY_LOGO_URL),
  };
}
