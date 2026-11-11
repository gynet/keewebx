import { Logger } from 'util/logger';

const logger = new Logger('otp');

export interface OtpParams {
    type: 'hotp' | 'totp';
    secret: string;
    algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
    digits?: string | number;
    counter?: number | string;
    period?: number;
    account?: string;
    issuer?: string;
}

export type OtpNextCallback = (
    err: Error | string | null,
    pass?: string,
    timeLeft?: number
) => void;

type HmacCallback = (sig: ArrayBuffer | null, err?: Error) => void;

class Otp {
    url: string;
    type: 'hotp' | 'totp';
    account?: string;
    secret: string;
    issuer?: string;
    algorithm: string;
    digits: number;
    counter?: number;
    period: number;
    key: ArrayBuffer;

    constructor(url: string, params: OtpParams) {
        if (['hotp', 'totp'].indexOf(params.type) < 0) {
            throw 'Bad type: ' + params.type;
        }
        if (!params.secret) {
            throw 'Empty secret';
        }
        if (params.algorithm && ['SHA1', 'SHA256', 'SHA512'].indexOf(params.algorithm) < 0) {
            throw 'Bad algorithm: ' + params.algorithm;
        }
        if (params.digits !== undefined && ['6', '7', '8'].indexOf(String(params.digits)) < 0) {
            throw 'Bad digits: ' + params.digits;
        }
        if (params.type === 'hotp') {
            // RFC 4226: counter is a non-negative integer. Counter=0 is valid (#28).
            // params.counter may arrive as a number (programmatic) or string (parsed from URL),
            // so coerce + validate explicitly instead of using a falsy check.
            if (
                params.counter === undefined ||
                params.counter === null ||
                params.counter === ''
            ) {
                throw 'Bad counter: ' + params.counter;
            }
            const counterNum = Number(params.counter);
            if (
                !Number.isFinite(counterNum) ||
                counterNum < 0 ||
                Math.floor(counterNum) !== counterNum
            ) {
                throw 'Bad counter: ' + params.counter;
            }
            params.counter = counterNum;
        }
        if (
            (params.period !== undefined && isNaN(params.period)) ||
            (params.period !== undefined && params.period < 1)
        ) {
            throw 'Bad period: ' + params.period;
        }

        this.url = url;
        this.type = params.type;
        this.account = params.account;
        this.secret = params.secret;
        this.issuer = params.issuer;
        this.algorithm = params.algorithm ? params.algorithm.toUpperCase() : 'SHA1';
        this.digits = params.digits ? +params.digits : 6;
        this.counter = params.counter as number | undefined;
        this.period = params.period ? +params.period : 30;

        const key = Otp.fromBase32(this.secret);
        if (!key) {
            throw 'Bad key';
        }
        this.key = key;
    }

    next(callback: OtpNextCallback): void {
        let valueForHashing: number;
        let timeLeft: number | undefined;
        if (this.type === 'totp') {
            const now = Date.now();
            const epoch = Math.round(now / 1000);
            valueForHashing = Math.floor(epoch / this.period);
            const msPeriod = this.period * 1000;
            timeLeft = msPeriod - (now % msPeriod);
        } else {
            valueForHashing = this.counter ?? 0;
        }
        const data = new Uint8Array(8).buffer;
        new DataView(data).setUint32(4, valueForHashing);
        this.hmac(data, (sig, err) => {
            if (!sig) {
                logger.error('OTP calculation error', err);
                return callback(err ?? 'hmac error');
            }
            const sigView = new DataView(sig);
            const offset = sigView.getInt8(sigView.byteLength - 1) & 0xf;
            const hmac = sigView.getUint32(offset) & 0x7fffffff;
            let pass: string;
            if (this.issuer === 'Steam') {
                pass = Otp.hmacToSteamCode(hmac);
            } else {
                pass = Otp.hmacToDigits(hmac, this.digits);
            }
            callback(null, pass, timeLeft);
        });
    }

    private hmac(data: ArrayBuffer, callback: HmacCallback): void {
        // Safari < 11 exposed WebCrypto under `webkitSubtle` rather than
        // the standard `subtle` name. We narrow via a structural shim
        // rather than `as any` so the call sites below stay typed.
        interface CryptoWithWebkit extends Crypto {
            webkitSubtle?: SubtleCrypto;
        }
        const cryptoWithWebkit = window.crypto as CryptoWithWebkit;
        const subtle: SubtleCrypto = cryptoWithWebkit.subtle ?? cryptoWithWebkit.webkitSubtle!;
        const algo = {
            name: 'HMAC',
            hash: { name: this.algorithm.replace('SHA', 'SHA-') }
        };
        subtle
            .importKey('raw', this.key, algo, false, ['sign'])
            .then((key: CryptoKey) => {
                subtle
                    .sign(algo, key, data)
                    .then((sig: ArrayBuffer) => {
                        callback(sig);
                    })
                    .catch((err: Error) => {
                        callback(null, err);
                    });
            })
            .catch((err: Error) => {
                callback(null, err);
            });
    }

    static hmacToDigits(hmac: number, length: number): string {
        let code = hmac.toString();
        code = Otp.leftPad(code.substring(code.length - length), length);
        return code;
    }

    static hmacToSteamCode(hmac: number): string {
        const steamChars = '23456789BCDFGHJKMNPQRTVWXY';
        let code = '';
        for (let i = 0; i < 5; ++i) {
            code += steamChars.charAt(hmac % steamChars.length);
            hmac /= steamChars.length;
        }
        return code;
    }

    static fromBase32(str: string): ArrayBuffer | null {
        str = str.replace(/\s/g, '');
        const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
        let bin = '';
        let i;
        for (i = 0; i < str.length; i++) {
            const ix = alphabet.indexOf(str[i].toLowerCase());
            if (ix < 0) {
                return null;
            }
            bin += Otp.leftPad(ix.toString(2), 5);
        }
        const hex = new Uint8Array(Math.floor(bin.length / 8));
        for (i = 0; i < hex.length; i++) {
            const chunk = bin.substring(i * 8, i * 8 + 8);
            hex[i] = parseInt(chunk, 2);
        }
        return hex.buffer;
    }

    static leftPad(str: string, len: number): string {
        while (str.length < len) {
            str = '0' + str;
        }
        return str;
    }

    static parseUrl(url: string): Otp {
        const match = /^otpauth:\/\/(\w+)(?:\/([^?]+)\?|\?)(.*)/i.exec(url);
        if (!match) {
            throw 'Not OTP url';
        }
        // The OtpParams object is built incrementally from URL components;
        // not all fields are present at construction time. We type it as
        // a loose mutable record here, then pass to the Otp constructor
        // which validates the required fields.
        const params: Record<string, string> = {};
        const label = decodeURIComponent(match[2] ?? 'default');
        if (label) {
            const parts = label.split(':');
            params.issuer = parts[0].trim();
            if (parts.length > 1) {
                params.account = parts[1].trim();
            }
        }
        params.type = match[1].toLowerCase();
        match[3].split('&').forEach((part) => {
            const parts = part.split('=', 2);
            params[parts[0].toLowerCase()] = decodeURIComponent(parts[1]);
        });
        return new Otp(url, params as unknown as OtpParams);
    }

    static isSecret(str: string): boolean {
        return !!Otp.fromBase32(str);
    }

    static makeUrl(secret: string, period?: number, digits?: number): string {
        return (
            'otpauth://totp/default?secret=' +
            secret +
            (period ? '&period=' + period : '') +
            (digits ? '&digits=' + digits : '')
        );
    }
}

export { Otp };
