# Species images

One `<slug>.json` per species — a curated shortlist of photos shown in the detail
sheet. Read by `pipeline/publish/site.py` into the `images` field of the payload.

Seeded by `scripts/pull_species_images.py`, which pulls **CC0 / CC BY 4.0** photos
from **iNaturalist Research-Grade** observations (via the GBIF occurrence API)
whose accepted taxon is the species. Selection is deterministic (lowest GBIF
occurrence keys) so re-runs are stable.

Each entry:

```json
{
  "url": "https://inaturalist-open-data.s3.amazonaws.com/photos/<id>/large.jpg",
  "credit": "<photographer>",
  "license": "CC BY 4.0",
  "photo_url": "https://www.inaturalist.org/photos/<id>",
  "observation_url": "https://www.inaturalist.org/observations/<id>",
  "source": "iNaturalist (Research Grade)",
  "reviewed": false
}
```

`reviewed` is `false` until a person (ideally with a mycologist) has confirmed the
identification on the linked observation. This file is committed content — the
weekly build never regenerates it; edit it by hand after review.
