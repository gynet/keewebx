import * as kdbxweb from 'kdbxweb';

class SecureInput {
    el: JQuery<HTMLInputElement> | null = null;
    minChar: number;
    maxLen: number;
    length: number;
    pseudoValue: string;
    salt: Uint32Array;

    constructor() {
        this.minChar = 0x1400 + Math.round(Math.random() * 100);
        this.maxLen = 1024;
        this.length = 0;
        this.pseudoValue = '';
        this.salt = new Uint32Array(0);
    }

    setElement(el: JQuery<HTMLInputElement>): void {
        this.el = el;
        this.el.val(this.pseudoValue);
        this.el.on('input', this._input.bind(this));
    }

    reset(): void {
        this.el = null;
        this.length = 0;
        this.pseudoValue = '';

        if (this.salt) {
            for (let i = 0; i < this.salt.length; i++) {
                this.salt[i] = 0;
            }
        }
        this.salt = new Uint32Array(0);
    }

    _input(): void {
        if (!this.el) return;
        const inputEl = this.el[0] as HTMLInputElement;
        const selStart = inputEl.selectionStart ?? 0;
        const value = this.el.val() as string;
        let newPs = '';
        const newSalt = new Uint32Array(this.maxLen);
        let valIx = 0,
            psIx = 0;
        while (valIx < value.length) {
            const valCh = value.charCodeAt(valIx);
            const psCh = this.pseudoValue.charCodeAt(psIx);
            const isSpecial = this._isSpecialChar(valCh);
            if (psCh === valCh) {
                // not changed
                newPs += this._getChar(newPs.length);
                newSalt[newPs.length - 1] = psCh ^ this.salt[psIx] ^ newPs.charCodeAt(newPs.length - 1);
                psIx++;
                valIx++;
            } else if (isSpecial) {
                // deleted
                psIx++;
            } else {
                // inserted or replaced
                newPs += this._getChar(newPs.length);
                newSalt[newPs.length - 1] = newPs.charCodeAt(newPs.length - 1) ^ valCh;
                valIx++;
            }
        }
        this.length = newPs.length;
        this.pseudoValue = newPs;
        this.salt = newSalt;
        this.el.val(newPs);
        inputEl.selectionStart = selStart;
        inputEl.selectionEnd = selStart;
    }

    _getChar(ix: number): string {
        return String.fromCharCode(this.minChar + ix);
    }

    _isSpecialChar(ch: number): boolean {
        return ch >= this.minChar && ch <= this.minChar + this.maxLen;
    }

    get value(): kdbxweb.ProtectedValue {
        const pseudoValue = this.pseudoValue;
        const salt = this.salt;
        const len = pseudoValue.length;
        let byteLength = 0;
        const valueBytes = new Uint8Array(len * 4);
        const saltBytes = kdbxweb.CryptoEngine.random(len * 4);
        for (let i = 0; i < len; i++) {
            const pseudoCharCode = pseudoValue.charCodeAt(i);
            const ch = String.fromCharCode(salt[i] ^ pseudoCharCode);
            const bytes = kdbxweb.ByteUtils.stringToBytes(ch);
            for (let j = 0; j < bytes.length; j++) {
                valueBytes[byteLength] = bytes[j] ^ saltBytes[byteLength];
                byteLength++;
            }
        }
        // `.buffer.slice` returns ArrayBuffer | SharedArrayBuffer under
        // strict TS because Uint8Array's backing buffer is typed as
        // ArrayBufferLike. kdbxweb.ProtectedValue's constructor wants
        // a concrete ArrayBuffer, so copy through a fresh allocation.
        const valueBuf = new ArrayBuffer(byteLength);
        new Uint8Array(valueBuf).set(valueBytes.subarray(0, byteLength));
        const saltBuf = new ArrayBuffer(byteLength);
        new Uint8Array(saltBuf).set(saltBytes.subarray(0, byteLength));
        return new kdbxweb.ProtectedValue(valueBuf, saltBuf);
    }
}

export { SecureInput };
