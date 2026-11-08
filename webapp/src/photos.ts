// Photos are shrunk in the browser before uploading: a phone camera's 4–8 MB photo
// becomes a few hundred KB, which uploads quickly on mobile data. The server re-encodes
// whatever it gets, so this is only about upload size.

// The same as the server's photoMaxSide.
const MAX_SIDE = 2048;
const QUALITY = 0.85;

// Files at most this size that need no scaling are sent as they are.
const SMALL_ENOUGH = 1024 * 1024;

function loadImage(file: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('unreadable image'));
        };
        img.src = url;
    });
}

// fitWithin is the size an image is drawn at so neither side exceeds maxSide.
export function fitWithin(width: number, height: number, maxSide: number): {width: number; height: number} {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
}

// shrinkPhoto returns a JPEG no larger than MAX_SIDE. Browsers draw an <img> with its
// EXIF rotation applied, so the result is upright. If the browser can't read the file
// (HEIC outside Safari, say), it is sent as is and the server decides.
export async function shrinkPhoto(file: File): Promise<Blob> {
    let img: HTMLImageElement;
    try {
        img = await loadImage(file);
    } catch {
        return file;
    }
    const size = fitWithin(img.naturalWidth, img.naturalHeight, MAX_SIDE);
    if (size.width === img.naturalWidth && file.size <= SMALL_ENOUGH && (/^image\/(jpeg|png|gif|webp)$/).test(file.type)) {
        return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return file;
    }

    // White behind transparent areas, as the server does.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(img, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    return blob || file;
}
