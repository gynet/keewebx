declare module 'jsqrcode' {
    export default class QrCode {
        constructor(image: HTMLImageElement);
        decode(): string;
    }
}
