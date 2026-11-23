/**
 * Sizes in pixels, and their translation to what a provider's model takes:
 * one of a set of sizes, an aspect ratio, or pixels within its own bounds.
 */

export interface Size {
  width: number;
  height: number;
}

/** How far apart two shapes are: 0 for the same aspect ratio. */
function shapeDistance(a: Size, b: Size): number {
  return Math.abs(Math.log(a.width / a.height) - Math.log(b.width / b.height));
}

/** `W:H` or `WxH` as a size, or nothing when the text is neither. */
export function parseSize(text: string): Size | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*[:xX]\s*(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return undefined;
  const [width, height] = [Number(match[1]), Number(match[2])];
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * The one of `sizes` closest to `size`: the nearest shape, and among equal
 * shapes the nearest area.
 */
export function nearestSize(size: Size, sizes: readonly Size[]): Size {
  const area = (one: Size) => one.width * one.height;
  return [...sizes].sort(
    (a, b) =>
      shapeDistance(size, a) - shapeDistance(size, b) ||
      Math.abs(area(a) - area(size)) - Math.abs(area(b) - area(size)),
  )[0];
}

/** The one of `ratios`, each `W:H`, whose shape is closest to `size`. */
export function nearestRatio(size: Size, ratios: readonly string[]): string {
  const parsed = ratios.flatMap((ratio) => {
    const shape = parseSize(ratio);
    return shape ? [{ ratio, shape }] : [];
  });
  return parsed.sort(
    (a, b) => shapeDistance(size, a.shape) - shapeDistance(size, b.shape),
  )[0].ratio;
}

/**
 * `size` brought within a model's bounds, keeping its shape as nearly as
 * the bounds allow: each side a multiple of `multiple` and at most
 * `maxSide`, the area between `minPixels` and `maxPixels`, and the longer
 * side at most `maxRatio` times the shorter.
 */
export function fitSize(
  size: Size,
  bounds: {
    multiple: number;
    maxSide: number;
    minPixels: number;
    maxPixels: number;
    maxRatio?: number;
  },
): Size {
  const maxRatio = bounds.maxRatio ?? Number.POSITIVE_INFINITY;
  const top = bounds.maxSide - (bounds.maxSide % bounds.multiple);
  let { width, height } = size;
  width = Math.min(width, height * maxRatio);
  height = Math.min(height, width * maxRatio);
  const scale = (factor: number) => {
    width *= factor;
    height *= factor;
  };
  if (width * height < bounds.minPixels)
    scale(Math.sqrt(bounds.minPixels / (width * height)));
  if (width * height > bounds.maxPixels)
    scale(Math.sqrt(bounds.maxPixels / (width * height)));
  if (Math.max(width, height) > bounds.maxSide)
    scale(bounds.maxSide / Math.max(width, height));
  const snap = (side: number) =>
    Math.min(
      top,
      Math.max(
        bounds.multiple,
        Math.round(side / bounds.multiple) * bounds.multiple,
      ),
    );
  const fitted = { width: snap(width), height: snap(height) };
  // Rounding can leave the shape or the area a step outside its bounds: move one side a step back in.
  const sides = (): ["width" | "height", "width" | "height"] =>
    fitted.width >= fitted.height ? ["width", "height"] : ["height", "width"];
  const tooLong = (longer: number, shorter: number) =>
    longer > top || longer > shorter * maxRatio;
  const shrink = () => {
    fitted[sides()[0]] -= bounds.multiple;
  };
  // The longer side grows unless that passes its own bounds; then the shorter does.
  const grow = () => {
    const [longer, shorter] = sides();
    const grown = fitted[longer] + bounds.multiple;
    fitted[tooLong(grown, fitted[shorter]) ? shorter : longer] +=
      bounds.multiple;
  };
  while (tooLong(fitted[sides()[0]], fitted[sides()[1]])) shrink();
  while (fitted.width * fitted.height < bounds.minPixels) grow();
  while (fitted.width * fitted.height > bounds.maxPixels) shrink();
  return fitted;
}
