export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

/** Owns the single transient object URL used by the processed-frame preview. */
export class FramePreviewUrl {
  private currentUrl: string | null = null;

  constructor(private readonly urlApi: ObjectUrlApi = URL) {}

  show(blob: Blob, image: HTMLImageElement | null): string {
    const nextUrl = this.urlApi.createObjectURL(blob);
    const previousUrl = this.currentUrl;
    this.currentUrl = nextUrl;
    if (image) image.src = nextUrl;
    if (previousUrl) this.urlApi.revokeObjectURL(previousUrl);
    return nextUrl;
  }

  clear(image: HTMLImageElement | null): void {
    if (this.currentUrl) this.urlApi.revokeObjectURL(this.currentUrl);
    this.currentUrl = null;
    image?.removeAttribute('src');
  }
}
