/** Raster input only; normalize locally before adding an icon to the encrypted vault. */
export async function normalizeIcon(image: Blob): Promise<string> {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type) || image.size > 1024 * 1024)
        throw new Error('Choose a PNG, JPEG, or WebP image up to 1 MB.');
    const bitmap = await createImageBitmap(image);
    try {
        if (!bitmap.width || !bitmap.height || bitmap.width > 8192 || bitmap.height > 8192) throw new Error('This image is too large or invalid.');
        const scale = Math.min(1, 128 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d'); if (!context) throw new Error('Image processing is unavailable.');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png').split(',')[1];
    } finally { bitmap.close(); }
}
