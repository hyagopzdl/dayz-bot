import fs from "fs";
import path from "path";
import sharp from "sharp";

const DEFAULT_MAP_PATH = "assets/maps/chernarus-map-pz-bot.png";
const MAP_WORLD_SIZE = Number(process.env.SHOP_MAP_WORLD_SIZE || 15360);
const MAP_SOURCE_SIZE = Number(process.env.SHOP_MAP_IMAGE_SIZE || 2048);
const PREVIEW_SIZE = Number(process.env.SHOP_MAP_PREVIEW_SIZE || 768);
const CROP_SIZE = Number(process.env.SHOP_MAP_CROP_SIZE || 520);

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getMapPath() {
  return path.resolve(process.cwd(), process.env.SHOP_MAP_IMAGE_PATH || DEFAULT_MAP_PATH);
}

function coordinateToPixel(x: number, z: number) {
  const px = (x / MAP_WORLD_SIZE) * MAP_SOURCE_SIZE;
  const py = MAP_SOURCE_SIZE - (z / MAP_WORLD_SIZE) * MAP_SOURCE_SIZE;

  return {
    px: clamp(px, 0, MAP_SOURCE_SIZE),
    py: clamp(py, 0, MAP_SOURCE_SIZE),
  };
}

function buildPinSvg(size = 76) {
  const cx = size / 2;
  const cy = size * 0.34;
  const radius = size * 0.2;

  return Buffer.from(`
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>
  <path filter="url(#shadow)" d="M ${cx} ${size * 0.93} C ${cx - size * 0.23} ${size * 0.62}, ${cx - size * 0.32} ${size * 0.47}, ${cx - size * 0.32} ${cy} C ${cx - size * 0.32} ${size * 0.16}, ${cx - size * 0.16} ${size * 0.04}, ${cx} ${size * 0.04} C ${cx + size * 0.16} ${size * 0.04}, ${cx + size * 0.32} ${size * 0.16}, ${cx + size * 0.32} ${cy} C ${cx + size * 0.32} ${size * 0.47}, ${cx + size * 0.23} ${size * 0.62}, ${cx} ${size * 0.93} Z" fill="#e11d48"/>
  <circle cx="${cx}" cy="${cy}" r="${radius}" fill="#ffffff"/>
  <circle cx="${cx}" cy="${cy}" r="${radius * 0.55}" fill="#e11d48"/>
</svg>`);
}

export async function generateShopMapPreview(params: {
  x: number;
  z: number;
}) {
  const mapPath = getMapPath();

  if (!fs.existsSync(mapPath)) {
    throw new Error(`Shop map image not found: ${mapPath}`);
  }

  const { px, py } = coordinateToPixel(params.x, params.z);
  const cropSize = clamp(CROP_SIZE, 256, MAP_SOURCE_SIZE);
  const half = cropSize / 2;
  const left = Math.round(clamp(px - half, 0, MAP_SOURCE_SIZE - cropSize));
  const top = Math.round(clamp(py - half, 0, MAP_SOURCE_SIZE - cropSize));
  const localX = Math.round(px - left);
  const localY = Math.round(py - top);

  const pinSize = 76;
  const pin = await sharp(buildPinSvg(pinSize)).png().toBuffer();

  const buffer = await sharp(mapPath)
    .extract({
      left,
      top,
      width: cropSize,
      height: cropSize,
    })
    .resize(PREVIEW_SIZE, PREVIEW_SIZE)
    .composite([
      {
        input: pin,
        left: Math.round((localX / cropSize) * PREVIEW_SIZE - pinSize / 2),
        top: Math.round((localY / cropSize) * PREVIEW_SIZE - pinSize * 0.92),
      },
    ])
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();

  return {
    buffer,
    filename: `shop-delivery-${Math.round(params.x)}-${Math.round(params.z)}.jpg`,
  };
}
