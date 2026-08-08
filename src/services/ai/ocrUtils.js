// Normalizes MLKit OCR block bounding boxes (pixel coordinates) into fractional
// coordinates (0-1) relative to the asset's full dimensions, so they stay valid
// regardless of the resolution the OCR ran at.
export function processBlocksToMetadata(result, asset) {
  if (!result || !result.blocks || !asset.width || !asset.height) return null;
  console.log(`[ocrUtils] processBlocksToMetadata: Normalizing coordinates using asset.width=${asset.width}, asset.height=${asset.height}`);
  const blocksList = [];
  for (let i = 0; i < result.blocks.length; i++) {
    const block = result.blocks[i];
    if (block.frame) {
      if (i < 5) {
        console.log(`[ocrUtils] Block ${i}: text="${block.text.replace(/\n/g, ' ')}", frame: left=${block.frame.left}, top=${block.frame.top}, right=${block.frame.right}, bottom=${block.frame.bottom}`);
      }
      const w = (block.frame.right - block.frame.left) / asset.width;
      const h = (block.frame.bottom - block.frame.top) / asset.height;
      const x = block.frame.left / asset.width;
      const y = block.frame.top / asset.height; // top-left origin
      blocksList.push({
         text: block.text,
         frame: { x, y, w, h }
      });
    }
  }
  return blocksList;
}
