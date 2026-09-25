export const CANVAS_SIZE = 512;
const CONTENT_BOX = 380;

const fitInside = (width, height, box) => (width >= height
  ? { width: box, height: Math.round((height * box) / width) }
  : { width: Math.round((width * box) / height), height: box });

/**
 * Draws the sticker onto a 512×512 canvas. 'original' shows the untouched
 * source; 'telegram' applies transform, outline and text the same way the
 * static save does. Animated saves are rendered by the server, so for them
 * this is an approximate single-frame preview.
 */
export function renderSticker(ctx, image, params, mode = 'telegram') {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (!sourceWidth || !sourceHeight) return;

  if (mode === 'original') {
    const size = fitInside(sourceWidth, sourceHeight, CANVAS_SIZE);
    ctx.drawImage(image, (CANVAS_SIZE - size.width) / 2, (CANVAS_SIZE - size.height) / 2, size.width, size.height);
    return;
  }

  const size = fitInside(sourceWidth, sourceHeight, CONTENT_BOX);
  const drawX = -size.width / 2;
  const drawY = -size.height / 2;
  const transform = (context) => {
    context.translate(CANVAS_SIZE / 2, CANVAS_SIZE / 2);
    context.rotate((params.rotation * Math.PI) / 180);
    context.scale(params.scale, params.scale);
  };

  if (params.strokeActive && params.strokeWidth > 0) {
    const silhouette = document.createElement('canvas');
    silhouette.width = CANVAS_SIZE;
    silhouette.height = CANVAS_SIZE;
    const sCtx = silhouette.getContext('2d');
    sCtx.save();
    transform(sCtx);
    sCtx.drawImage(image, drawX, drawY, size.width, size.height);
    sCtx.restore();
    sCtx.globalCompositeOperation = 'source-in';
    sCtx.fillStyle = params.strokeColor;
    sCtx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    for (let angle = 0; angle < Math.PI * 2; angle += 0.25) {
      ctx.drawImage(silhouette, Math.cos(angle) * params.strokeWidth, Math.sin(angle) * params.strokeWidth);
    }
  }

  ctx.save();
  transform(ctx);
  ctx.drawImage(image, drawX, drawY, size.width, size.height);
  ctx.restore();

  ctx.font = 'bold 36px Impact, Arial Black, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 5;
  ctx.textAlign = 'center';
  if (params.topText) {
    ctx.strokeText(params.topText.toUpperCase(), CANVAS_SIZE / 2, 60);
    ctx.fillText(params.topText.toUpperCase(), CANVAS_SIZE / 2, 60);
  }
  if (params.bottomText) {
    ctx.strokeText(params.bottomText.toUpperCase(), CANVAS_SIZE / 2, 460);
    ctx.fillText(params.bottomText.toUpperCase(), CANVAS_SIZE / 2, 460);
  }
}
