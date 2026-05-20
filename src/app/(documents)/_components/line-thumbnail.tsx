// Line-item thumbnail cell for printable documents. 40x40, matching the
// detail-page thumbnails. Tagged with `doc-thumb` so the toolbar's
// ThumbnailToggle can hide the whole column (header + cells) on screen
// and in print via a single class on the document root.
//
// `LineThumbnailHead` renders the matching header cell (also `doc-thumb`)
// so the column collapses cleanly when hidden.

export function LineThumbnailHead() {
  return <th className="doc-thumb w-12 py-2 pr-3 font-semibold" />;
}

export function LineThumbnailCell({
  url,
  alt,
}: {
  url: string | null;
  alt: string;
}) {
  return (
    <td className="doc-thumb py-2 pr-3 align-top">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={alt}
          className="size-10 rounded border border-border object-cover"
        />
      ) : (
        <div className="size-10 rounded border border-dashed border-border" />
      )}
    </td>
  );
}
