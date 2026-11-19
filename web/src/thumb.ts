// List thumbnails. iNaturalist's open-data bucket serves every photo in fixed
// size variants under the same path (square 75 px, small 240 px, medium,
// large), so any one of them names the others. The manifest carries the
// `small` URL per species (pipeline/publish/site.py); an older payload only has
// the `large` one in the species documents. Either way the row gets the square
// for 1x screens and the small one for dense screens: a few kB each, from an
// origin the detail view already loads from.

const INAT_VARIANT = /^(https:\/\/[^?#]+\/photos\/\d+\/)(?:large|medium|small|square)(\.[a-z]+)$/i;

export interface ThumbSources {
  src: string;
  srcset?: string;
}

export function thumbSources(url: string): ThumbSources {
  const match = INAT_VARIANT.exec(url);
  if (!match) return { src: url };
  const [, base, ext] = match;
  return {
    src: `${base}square${ext}`,
    srcset: `${base}square${ext} 75w, ${base}small${ext} 240w`,
  };
}
