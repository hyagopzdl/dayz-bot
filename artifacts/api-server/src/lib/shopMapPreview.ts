import fs from "fs";
import path from "path";
import sharp from "sharp";

const DEFAULT_MAP_PATH = "assets/maps/chernarus-map-pz-bot.png";
const DEFAULT_PIN_PATH = "assets/ui/map-pin.png";

const MAP_WORLD_SIZE = Number(process.env.SHOP_MAP_WORLD_SIZE || 15360);
const MAP_SOURCE_SIZE = Number(process.env.SHOP_MAP_IMAGE_SIZE || 2048);
const PREVIEW_SIZE = Number(process.env.SHOP_MAP_PREVIEW_SIZE || 768);
const CROP_SIZE = Number(process.env.SHOP_MAP_CROP_SIZE || 300);
const PIN_SIZE = Number(process.env.SHOP_MAP_PIN_SIZE || 76);

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getMapPath() {
  return path.resolve(
    process.cwd(),
    process.env.SHOP_MAP_IMAGE_PATH || DEFAULT_MAP_PATH,
  );
}

function getPinPath() {
  return path.resolve(
    process.cwd(),
    process.env.SHOP_MAP_PIN_PATH || DEFAULT_PIN_PATH,
  );
}

function coordinateToPixel(x: number, z: number) {
  const px = (x / MAP_WORLD_SIZE) * MAP_SOURCE_SIZE;
  const py = MAP_SOURCE_SIZE - (z / MAP_WORLD_SIZE) * MAP_SOURCE_SIZE;

  return {
    px: clamp(px, 0, MAP_SOURCE_SIZE),
    py: clamp(py, 0, MAP_SOURCE_SIZE),
  };
}

async function loadPinBuffer() {
  const pinPath = getPinPath();

  if (!fs.existsSync(pinPath)) {
    throw new Error(`Shop map pin image not found: ${pinPath}`);
  }

  return sharp(pinPath)
    .resize(PIN_SIZE, PIN_SIZE, {
      fit: "contain",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();
}

export async function generateShopMapPreview(params: { x: number; z: number }) {
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

  const pin = await loadPinBuffer();

  const pinLeft = Math.round((localX / cropSize) * PREVIEW_SIZE - PIN_SIZE / 2);
  const pinTop = Math.round(
    (localY / cropSize) * PREVIEW_SIZE - PIN_SIZE * 0.92,
  );

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
        left: pinLeft,
        top: pinTop,
      },
    ])
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();

  return {
    buffer,
    filename: `shop-delivery-${Math.round(params.x)}-${Math.round(params.z)}.jpg`,
  };
}
