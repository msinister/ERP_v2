import type { CompanyInfo } from '@/lib/company-info';

export type DocumentMetadataItem = {
  label: string;
  value: string;
};

// Top-of-document chrome — company info (or logo + name) on the left,
// document title + key metadata pairs on the right. Used by every
// doc page so branding stays consistent.

export function DocumentHeader({
  company,
  title,
  metadata,
}: {
  company: CompanyInfo;
  title: string;
  metadata: DocumentMetadataItem[];
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-6 border-b border-border pb-4">
      <div className="space-y-1">
        {company.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={company.logoUrl}
            alt={`${company.name} logo`}
            className="max-h-16 max-w-[240px] object-contain"
          />
        ) : null}
        <div className="text-base font-semibold">{company.name}</div>
        <CompanyAddressLines company={company} />
        <CompanyContactLines company={company} />
      </div>

      <div className="min-w-[200px] space-y-3 text-right">
        <h1 className="text-2xl font-bold uppercase tracking-wide">
          {title}
        </h1>
        {metadata.length > 0 ? (
          <dl className="space-y-1 text-xs">
            {metadata.map((m) => (
              <div
                key={m.label}
                className="flex items-baseline justify-end gap-3"
              >
                <dt className="uppercase tracking-wide text-muted-foreground">
                  {m.label}
                </dt>
                <dd className="font-mono text-sm text-foreground">{m.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </header>
  );
}

function CompanyAddressLines({ company }: { company: CompanyInfo }) {
  const cityRegionPostal = [
    company.city,
    company.region,
    company.postalCode,
  ]
    .filter(Boolean)
    .join(company.city && company.region ? ', ' : ' ')
    .trim();
  return (
    <div className="text-xs text-muted-foreground">
      {company.addressLine1 ? <div>{company.addressLine1}</div> : null}
      {company.addressLine2 ? <div>{company.addressLine2}</div> : null}
      {cityRegionPostal ? <div>{cityRegionPostal}</div> : null}
      {company.country ? <div>{company.country}</div> : null}
    </div>
  );
}

function CompanyContactLines({ company }: { company: CompanyInfo }) {
  if (!company.phone && !company.email) return null;
  return (
    <div className="pt-1 text-xs text-muted-foreground">
      {company.phone ? <div>{company.phone}</div> : null}
      {company.email ? <div>{company.email}</div> : null}
    </div>
  );
}
