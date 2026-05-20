'use client';

import { useState } from 'react';
import { Image as ImageIcon, ImageOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Toolbar toggle that shows/hides line-item thumbnails. Flips a
// `thumbs-hidden` class on <html>; print.css hides `.doc-thumb` cells
// under that class both on screen (live preview) and in print output
// (so toggled-off thumbnails don't print). Default: thumbnails shown.
export function ThumbnailToggle() {
  const [shown, setShown] = useState(true);

  function toggle() {
    const next = !shown;
    setShown(next);
    document.documentElement.classList.toggle('thumbs-hidden', !next);
  }

  return (
    <Button variant="outline" size="sm" onClick={toggle}>
      {shown ? <ImageOff /> : <ImageIcon />}
      {shown ? 'Hide thumbnails' : 'Show thumbnails'}
    </Button>
  );
}
