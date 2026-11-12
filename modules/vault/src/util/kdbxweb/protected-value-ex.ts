import * as kdbxweb from 'kdbxweb';

// Monkey-patch surface on kdbxweb.ProtectedValue.
//
// The method signatures are declared as a module augmentation in
// `app/scripts/kdbxweb.d.ts`, so once this file runs at bootstrap the
// additional methods are type-safe to call everywhere else in the app.
//
// The prototype itself, however, still needs a loosely-typed write
// handle: the augmentation makes these look like members of the class,
// so TypeScript wants them defined at construction. We write directly
// to the prototype at runtime, which requires an indexable view. The
// smallest escape hatch that expresses "this is a bag of keys I'm
// attaching methods to" is `Record<string, unknown>` on the prototype.
const PVProto = kdbxweb.ProtectedValue.prototype as unknown as Record<string, unknown>;

const ExpectedFieldRefChars: string[] = '{REF:0@I:00000000000000000000000000000000}'.split('');
const ExpectedFieldRefByteLength: number = ExpectedFieldRefChars.length;

PVProto.isProtected = true;

PVProto.forEachChar = function (
    this: kdbxweb.ProtectedValue,
    fn: (charCode: number) => void | false
): void {
    const value: Uint8Array = this.value;
    const salt: Uint8Array = this.salt;
    let b: number, b1: number, b2: number, b3: number;
    for (let i = 0, len = value.length; i < len; i++) {
        b = value[i] ^ salt[i];
        if (b < 128) {
            if (fn(b) === false) {
                return;
            }
            continue;
        }
        i++;
        b1 = value[i] ^ salt[i];
        if (i === len) {
            break;
        }
        if (b >= 192 && b < 224) {
            if (fn(((b & 0x1f) << 6) | (b1 & 0x3f)) === false) {
                return;
            }
            continue;
        }
        i++;
        b2 = value[i] ^ salt[i];
        if (i === len) {
            break;
        }
        if (b >= 224 && b < 240) {
            if (fn(((b & 0xf) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)) === false) {
                return;
            }
            // The for-loop header will i++ again to advance past b2 to
            // the next codepoint's leading byte. Without this continue,
            // execution falls through into the 4-byte branch's pre-read
            // (i++; b3 = ...), which silently consumes a byte that
            // belongs to the NEXT codepoint — corrupting every character
            // that follows a 3-byte UTF-8 char. Inherited upstream bug
            // from keeweb; fixed here alongside multi-byte test coverage.
            continue;
        }
        i++;
        b3 = value[i] ^ salt[i];
        if (i === len) {
            break;
        }
        if (b >= 240 && b < 248) {
            let c = ((b & 7) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
            if (c <= 0xffff) {
                if (fn(c) === false) {
                    return;
                }
            } else {
                c ^= 0x10000;
                if (fn(0xd800 | (c >> 10)) === false) {
                    return;
                }
                if (fn(0xdc00 | (c & 0x3ff)) === false) {
                    return;
                }
            }
        }
        // skip error
    }
};

Object.defineProperty(kdbxweb.ProtectedValue.prototype, 'length', {
    get(this: kdbxweb.ProtectedValue): number {
        return this.textLength;
    }
});

Object.defineProperty(kdbxweb.ProtectedValue.prototype, 'textLength', {
    get(this: kdbxweb.ProtectedValue): number {
        let textLength = 0;
        this.forEachChar(() => {
            textLength++;
        });
        return textLength;
    }
});

PVProto.includesLower = function (this: kdbxweb.ProtectedValue, findLower: string): boolean {
    return this.indexOfLower(findLower) !== -1;
};

PVProto.indexOfLower = function (this: kdbxweb.ProtectedValue, findLower: string): number {
    let index = -1;
    const foundSeqs: number[] = [];
    const len = findLower.length;
    let chIndex = -1;
    this.forEachChar((ch: number) => {
        chIndex++;
        const chLower = String.fromCharCode(ch).toLowerCase();
        if (index !== -1) {
            return;
        }
        for (let i = 0; i < foundSeqs.length; i++) {
            const seqIx = ++foundSeqs[i];
            if (findLower[seqIx] !== chLower) {
                foundSeqs.splice(i, 1);
                i--;
                continue;
            }
            if (seqIx === len - 1) {
                index = chIndex - len + 1;
                return;
            }
        }
        if (findLower[0] === chLower) {
            if (len === 1) {
                index = chIndex - len + 1;
            } else {
                foundSeqs.push(0);
            }
        }
    });
    return index;
};

PVProto.indexOfSelfInLower = function (
    this: kdbxweb.ProtectedValue,
    targetLower: string
): number {
    let firstCharIndex = -1;
    let found = false;
    do {
        let chIndex = -1;
        this.forEachChar((ch: number) => {
            chIndex++;
            const chLower = String.fromCharCode(ch).toLowerCase();
            if (chIndex === 0) {
                firstCharIndex = targetLower.indexOf(chLower, firstCharIndex + 1);
                found = firstCharIndex !== -1;
                return;
            }
            if (!found) {
                return;
            }
            found = targetLower[firstCharIndex + chIndex] === chLower;
        });
    } while (!found && firstCharIndex >= 0);
    return firstCharIndex;
};

// Structural shape we read from `other` when it's another ProtectedValue.
// We avoid asserting `instanceof kdbxweb.ProtectedValue` because the
// legacy callers pass through several `unknown` boundaries; the
// `isProtected: true` discriminator (added by this same module) is the
// authoritative tell.
interface ProtectedValueLike {
    isProtected: true;
    byteLength: number;
    value: Uint8Array;
    salt: Uint8Array;
}

function isProtectedValueLike(other: unknown): other is ProtectedValueLike {
    if (typeof other !== 'object' || other === null) {
        return false;
    }
    const o = other as { isProtected?: unknown };
    return o.isProtected === true;
}

PVProto.equals = function (this: kdbxweb.ProtectedValue, other: unknown): boolean {
    if (!other) {
        return false;
    }
    if (!isProtectedValueLike(other)) {
        // Fallback for plain-string comparisons: kdbxweb.ProtectedValue.includes
        // takes a string and decrypts on the fly. Match the original
        // behaviour: agree on textLength then full plaintext compare.
        const len = (other as { length?: unknown }).length;
        if (typeof len !== 'number' || this.textLength !== len) {
            return false;
        }
        return this.includes(other as unknown as string);
    }
    if ((other as unknown) === (this as unknown)) {
        return true;
    }
    const len: number = this.byteLength;
    if (len !== other.byteLength) {
        return false;
    }
    for (let i = 0; i < len; i++) {
        if ((this.value[i] ^ this.salt[i]) !== (other.value[i] ^ other.salt[i])) {
            return false;
        }
    }
    return true;
};

PVProto.isFieldReference = function (this: kdbxweb.ProtectedValue): boolean {
    if (this.byteLength !== ExpectedFieldRefByteLength) {
        return false;
    }
    let ix = 0;
    let matches = true;
    this.forEachChar((ch: number) => {
        const expected = ExpectedFieldRefChars[ix++];
        // '0' is the placeholder that stands for the UUID hex digits
        // and the REF type char; every other position must match the
        // fixed prefix/suffix literal character code.
        if (expected !== '0' && ch !== expected.charCodeAt(0)) {
            matches = false;
            return false;
        }
    });
    return matches;
};

const RandomSalt: Uint8Array = kdbxweb.CryptoEngine.random(128);

PVProto.saltedValue = function (this: kdbxweb.ProtectedValue): string | number {
    if (!this.byteLength) {
        return 0;
    }
    const value: Uint8Array = this.value;
    const salt: Uint8Array = this.salt;
    let salted = '';
    for (let i = 0, len = value.length; i < len; i++) {
        const byte = value[i] ^ salt[i];
        salted += String.fromCharCode(byte ^ RandomSalt[i % RandomSalt.length]);
    }
    return salted;
};

PVProto.dataAndSalt = function (
    this: kdbxweb.ProtectedValue
): { data: number[]; salt: number[] } {
    return {
        data: [...this.value],
        salt: [...this.salt]
    };
};

// kdbxweb.ProtectedValue ships its own toBase64()/fromBase64(); we override
// here to keep the historical "zero the intermediate buffer after we're done
// with it" hygiene that the upstream method does not perform.
PVProto.toBase64 = function (this: kdbxweb.ProtectedValue): string {
    const binary = this.getBinary();
    const base64: string = kdbxweb.ByteUtils.bytesToBase64(binary);
    kdbxweb.ByteUtils.zeroBuffer(binary);
    return base64;
};

// `fromBase64` is a static (not a prototype method). kdbxweb already
// ships its own static fromBase64 — we override it here to plumb the
// Uint8Array result of `base64ToBytes` directly through `fromBinary`
// without the intermediate string round-trip the upstream version does.
// The augmentation in kdbxweb.d.ts also declares it on the namespace.
const PVStatic = kdbxweb.ProtectedValue as unknown as Record<string, unknown>;
PVStatic.fromBase64 = function (base64: string): kdbxweb.ProtectedValue {
    const bytes = kdbxweb.ByteUtils.base64ToBytes(base64);
    return kdbxweb.ProtectedValue.fromBinary(kdbxweb.ByteUtils.arrayToBuffer(bytes));
};
