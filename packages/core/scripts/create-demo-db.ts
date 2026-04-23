/**
 * Creates a KDBX4 Demo database for KeeWebX.
 *
 * Usage: bun run packages/core/scripts/create-demo-db.ts
 *
 * This replaces the legacy KDBX3 Demo.kdbx with a KDBX4 version
 * using AES-KDF (fast for demo) + AES-256-CBC encryption.
 */
import * as kdbxweb from '../../db/lib';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { argon2 } from '../../db/test/test-support/argon2';

async function createDemoDb() {
    // Register Argon2 implementation for key derivation
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);

    const password = kdbxweb.ProtectedValue.fromString('demo');
    const cred = new kdbxweb.Credentials(password);
    const db = kdbxweb.Kdbx.create(cred, 'Demo');

    // Upgrade to KDBX4 format with Argon2id + ChaCha20
    db.upgrade();
    db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
    // Default KDF params are already fast: 2 iterations, 1MB memory

    const root = db.getDefaultGroup();
    root.name = 'Demo';

    // --- Group: General ---
    const generalGroup = db.createGroup(root, 'General');
    generalGroup.icon = 48; // folder icon

    const entry1 = db.createEntry(generalGroup);
    entry1.fields.set('Title', 'Sample Entry');
    entry1.fields.set('UserName', 'User Name');
    entry1.fields.set('Password', kdbxweb.ProtectedValue.fromString('Password'));
    entry1.fields.set('URL', 'https://keepass.info/');
    entry1.fields.set('Notes', 'Notes');
    entry1.icon = 0;

    const entry2 = db.createEntry(generalGroup);
    entry2.fields.set('Title', 'Sample Entry #2');
    entry2.fields.set('UserName', 'Michael321');
    entry2.fields.set('Password', kdbxweb.ProtectedValue.fromString('12345'));
    entry2.fields.set('URL', 'https://keepass.info/help/kb/testform.html');
    entry2.fields.set('Notes', '');
    entry2.icon = 0;

    // --- Group: Email ---
    const emailGroup = db.createGroup(root, 'Email');
    emailGroup.icon = 19; // email icon

    const emailEntry = db.createEntry(emailGroup);
    emailEntry.fields.set('Title', 'ProtonMail');
    emailEntry.fields.set('UserName', 'demo@protonmail.com');
    emailEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('Pr0t0n!D3m0'));
    emailEntry.fields.set('URL', 'https://mail.protonmail.com');
    emailEntry.fields.set('Notes', 'End-to-end encrypted email');
    emailEntry.icon = 19;

    // --- Group: Internet ---
    const internetGroup = db.createGroup(root, 'Internet');
    internetGroup.icon = 1; // globe icon

    const ghEntry = db.createEntry(internetGroup);
    ghEntry.fields.set('Title', 'GitHub');
    ghEntry.fields.set('UserName', 'demouser');
    ghEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('Gh!tHub$ecure99'));
    ghEntry.fields.set('URL', 'https://github.com');
    ghEntry.fields.set('Notes', 'Source code hosting');
    ghEntry.icon = 1;

    const redditEntry = db.createEntry(internetGroup);
    redditEntry.fields.set('Title', 'Reddit');
    redditEntry.fields.set('UserName', 'demo_redditor');
    redditEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('R3dd!tP@ss'));
    redditEntry.fields.set('URL', 'https://www.reddit.com');
    redditEntry.fields.set('Notes', '');
    redditEntry.icon = 1;

    // --- Group: Banking ---
    const bankGroup = db.createGroup(root, 'Banking');
    bankGroup.icon = 37; // money icon

    const bankEntry = db.createEntry(bankGroup);
    bankEntry.fields.set('Title', 'Demo Bank');
    bankEntry.fields.set('UserName', 'demo_customer');
    bankEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('B@nk!ng2024'));
    bankEntry.fields.set('URL', 'https://www.example-bank.com');
    bankEntry.fields.set('Notes', 'Online banking portal\nCustomer ID: 12345678');
    bankEntry.icon = 37;

    // --- Group: Network ---
    const networkGroup = db.createGroup(root, 'Network');
    networkGroup.icon = 3; // network icon

    const wifiEntry = db.createEntry(networkGroup);
    wifiEntry.fields.set('Title', 'Home WiFi');
    wifiEntry.fields.set('UserName', 'admin');
    wifiEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('WiFi-P@ss-2024!'));
    wifiEntry.fields.set('URL', 'http://192.168.1.1');
    wifiEntry.fields.set('Notes', 'SSID: HomeNetwork\nRouter: TP-Link Archer');
    wifiEntry.icon = 3;

    // Enable recycle bin
    db.createRecycleBin();

    // Save the database
    const data = await db.save();
    const outputPath = resolve(__dirname, '../app/resources/Demo.kdbx');
    writeFileSync(outputPath, Buffer.from(data));

    console.log(`Demo database created at: ${outputPath}`);
    console.log(`Format: KDBX ${db.header.versionMajor}.${db.header.versionMinor}`);
    console.log(`Entries: 7`);
    console.log(`Groups: 5 + root + recycle bin`);
    console.log(`Password: "demo"`);

    // Verify it can be read back
    const readData = new Uint8Array(data).buffer;
    const readDb = await kdbxweb.Kdbx.load(
        readData,
        new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('demo'))
    );
    console.log(`Verification: loaded ${readDb.meta.name} v${readDb.header.versionMajor}`);

    kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
}

createDemoDb().catch((err) => {
    console.error('Failed to create demo database:', err);
    process.exit(1);
});
