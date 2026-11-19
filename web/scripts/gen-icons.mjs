// Rasterises public/favicon.svg into the PNG icons the manifest and iOS need,
// and public/og-image.svg into the share-card PNG.
// Run after editing either SVG:  npm run icons
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const svg = await readFile(join(pub, "favicon.svg"));
const BG = "#f4f3ee";

async function plain(size, name) {
  await sharp(svg, { density: 600 }).resize(size, size).png().toFile(join(pub, name));
  console.log(name);
}

async function maskable(size, name, inner) {
  const mark = await sharp(svg, { density: 600 }).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toFile(join(pub, name));
  console.log(name);
}

await plain(180, "icon-180.png"); // apple-touch-icon
await plain(192, "icon-192.png");
await plain(512, "icon-512.png");
await maskable(512, "icon-maskable-512.png", 380); // padded for the maskable safe zone

// Open Graph / Twitter share card, 1200x630.
await sharp(await readFile(join(pub, "og-image.svg")), { density: 200 })
  .resize(1200, 630)
  .png()
  .toFile(join(pub, "og-image.png"));
console.log("og-image.png");
