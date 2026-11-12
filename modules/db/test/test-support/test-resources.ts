import * as fs from 'fs';
import * as path from 'path';
import { ByteUtils } from '../../lib';

export const TestResources = {
    demoKey: readFile('demo.key'),
    argon2: readFile('Argon2.kdbx'),
    argon2id: readFile('Argon2id.kdbx'),
    argon2ChaCha: readFile('Argon2ChaCha.kdbx'),
    yubikey4: readFile('YubiKey4.kdbx'),
    emptyUuidXml: readFile('empty-uuid.xml'),
    kdbx41: readFile('KDBX4.1.kdbx')
};

function readFile(name: string): ArrayBuffer {
    const filePath = path.join(__dirname, '../../resources', name);
    const content = fs.readFileSync(filePath);
    return ByteUtils.arrayToBuffer(new Uint8Array(content));
}
