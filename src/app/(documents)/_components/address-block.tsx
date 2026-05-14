export type AddressData = {
  // Optional party name at the top (e.g. customer/vendor display name).
  name?: string | null;
  // Optional "Attn:" line.
  attention?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
};

// Header-and-body address block. Used for Bill-to / Ship-to / Vendor /
// Ship-from. Renders nothing-useful as "—" so the layout grid stays
// balanced when one block is sparse.

export function AddressBlock({
  label,
  address,
  // Free-text shippingAddress (SO/Invoice currently store a single
  // free-text field per docs/05). When set, this overrides the
  // structured `address` lines but keeps name/attention/phone/email
  // from the structured one if provided.
  freeText,
}: {
  label: string;
  address?: AddressData | null;
  freeText?: string | null;
}) {
  const cityRegionPostal = address
    ? [address.city, address.region, address.postalCode]
        .filter(Boolean)
        .join(address.city && address.region ? ', ' : ' ')
        .trim()
    : '';

  const hasStructuredBody =
    !!address &&
    (address.line1 ||
      address.line2 ||
      cityRegionPostal ||
      address.country);

  const empty =
    !freeText && !address?.name && !address?.attention && !hasStructuredBody;

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="space-y-0.5 text-sm">
        {address?.name ? (
          <div className="font-medium">{address.name}</div>
        ) : null}
        {address?.attention ? (
          <div className="text-muted-foreground">Attn: {address.attention}</div>
        ) : null}
        {freeText ? (
          <div className="whitespace-pre-line">{freeText}</div>
        ) : hasStructuredBody && address ? (
          <>
            {address.line1 ? <div>{address.line1}</div> : null}
            {address.line2 ? <div>{address.line2}</div> : null}
            {cityRegionPostal ? <div>{cityRegionPostal}</div> : null}
            {address.country ? (
              <div className="text-muted-foreground">{address.country}</div>
            ) : null}
          </>
        ) : null}
        {address?.phone || address?.email ? (
          <div className="pt-1 text-xs text-muted-foreground">
            {address.phone ? <div>{address.phone}</div> : null}
            {address.email ? <div>{address.email}</div> : null}
          </div>
        ) : null}
        {empty ? <div className="text-muted-foreground">—</div> : null}
      </div>
    </div>
  );
}
