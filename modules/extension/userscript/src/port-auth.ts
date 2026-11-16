import { sign } from 'tweetnacl';
import { fromBase64, toBase64 } from '../../src/background/utils';

export interface PortIdentity {
    appBoot: string;
    connectionId: string;
    endpoint: string;
    siteOrigin: string;
}

// Domain separation prevents a transport receipt from being used as an RPC.
const bytes = (value: PortIdentity) => new TextEncoder().encode(JSON.stringify([
    'keewebx-connect-port-ready-v1', value.appBoot, value.connectionId, value.endpoint, value.siteOrigin
]));

export function signPortReady(value: PortIdentity, secretKey: Uint8Array): string {
    return toBase64(sign.detached(bytes(value), secretKey));
}

export function verifyPortReady(value: PortIdentity, proof: unknown, publicKey: string): boolean {
    if (typeof proof !== 'string' || proof.length !== 88) return false;
    try { return sign.detached.verify(bytes(value), fromBase64(proof), fromBase64(publicKey)); }
    catch { return false; }
}
