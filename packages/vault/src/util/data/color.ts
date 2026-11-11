import { Colors } from 'const/colors';
import type { ColorName } from 'const/colors';

const KnownColors: Record<string, Color> = {};

function hex(num: number): string {
    const str = (num || 0).toString(16);
    return str.length < 2 ? '0' + str : str;
}

class Color {
    r: number = 0;
    g: number = 0;
    b: number = 0;
    h: number = 0;
    s: number = 0;
    l: number = 0;
    a: number = 1;

    static black: Color;

    constructor(arg: string | Color) {
        if (typeof arg === 'string') {
            const rgbaMatch = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(,\s*([\d.]+))?\)$/.exec(arg);
            if (rgbaMatch) {
                this.r = +rgbaMatch[1];
                this.g = +rgbaMatch[2];
                this.b = +rgbaMatch[3];
                this.a = rgbaMatch[5] ? +rgbaMatch[5] : 1;
                this.setHsl();
            } else {
                const hexMatch = /^#?([0-9a-f]{3,6})$/i.exec(arg);
                if (hexMatch) {
                    const digits = hexMatch[1];
                    const len = digits.length === 3 ? 1 : 2;
                    this.r = parseInt(digits.substr(0, len), 16);
                    this.g = parseInt(digits.substr(len, len), 16);
                    this.b = parseInt(digits.substr(len * 2, len), 16);
                    this.a = 1;
                    this.setHsl();
                } else {
                    this.r = this.g = this.b = this.h = this.s = this.l = 0;
                    this.a = 1;
                }
            }
        } else if (arg instanceof Color) {
            this.r = arg.r;
            this.g = arg.g;
            this.b = arg.b;
            this.h = arg.h;
            this.s = arg.s;
            this.l = arg.l;
            this.a = arg.a;
        }
    }

    setHsl(): void {
        const r = this.r / 255;
        const g = this.g / 255;
        const b = this.b / 255;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let h = 0;
        let s: number;
        const l = (max + min) / 2;

        if (max === min) {
            h = s = 0; // achromatic
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r:
                    h = (g - b) / d + (g < b ? 6 : 0);
                    break;
                case g:
                    h = (b - r) / d + 2;
                    break;
                case b:
                    h = (r - g) / d + 4;
                    break;
            }
            h /= 6;
        }

        this.h = h;
        this.s = s;
        this.l = l;
    }

    toHex(): string {
        return '#' + hex(this.r) + hex(this.g) + hex(this.b);
    }

    toRgba(): string {
        return `rgba(${Math.round(this.r)},${Math.round(this.g)},${Math.round(this.b)},${this.a})`;
    }

    toHsla(): string {
        return `hsla(${Math.round(this.h * 100)},${Math.round(this.s * 100)}%,${Math.round(
            this.l * 100
        )}%,${this.a})`;
    }

    distanceTo(color: Color): number {
        return Math.abs(this.h - color.h);
    }

    mix(another: Color, weight: number): Color {
        const res = new Color(this);
        const anotherWeight = 1 - weight;
        res.r = this.r * weight + another.r * anotherWeight;
        res.g = this.g * weight + another.g * anotherWeight;
        res.b = this.b * weight + another.b * anotherWeight;
        res.a = this.a * weight + another.a * anotherWeight;
        return res;
    }

    static getNearest(colorStr: string): string | null {
        const color = new Color(colorStr);
        if (!color.s) {
            return null;
        }
        let selected: string | null = null;
        let minDistance = Number.MAX_VALUE;
        for (const [name, col] of Object.entries(KnownColors)) {
            const distance = color.distanceTo(col);
            if (distance < minDistance) {
                minDistance = distance;
                selected = name;
            }
        }
        return selected;
    }

    static getKnownBgColor(knownColor: ColorName): string | undefined {
        return Colors.BgColors[knownColor] ? '#' + Colors.BgColors[knownColor] : undefined;
    }
}

for (const [name, val] of Object.entries(Colors.ColorsValues)) {
    KnownColors[name] = new Color(val);
}

Color.black = new Color('#000');

export { Color };
