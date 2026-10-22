const MAX_BYTES = 900_000;
const MAX_EDGE = 1600;

/** Liest ein Bild als Data-URL und verkleinert es, bis es unter dem BFF-Limit liegt. */
export async function fileToDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Nur PNG, JPEG, WebP oder GIF");
  const raw = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("Bild nicht lesbar"));
    r.readAsDataURL(file);
  });
  if (raw.length <= MAX_BYTES * 1.33) return raw;
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Bild nicht lesbar"));
    i.src = raw;
  });
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.7, 0.5]) {
    const out = canvas.toDataURL("image/jpeg", q);
    if (out.length <= MAX_BYTES * 1.33) return out;
  }
  throw new Error("Bild ist zu groß");
}
