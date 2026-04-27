/**
 * Creates a KDBX4 Demo database for KeeWebX.
 *
 * Usage: bun run packages/core/scripts/create-demo-db.ts
 *
 * Designed to showcase KeeWebX features at first launch:
 *   - Colorful tag chips (deterministic hue per tag string) — every
 *     entry carries 1-3 tags drawn from a curated palette so the
 *     details pane and sidebar tag-cloud both look populated.
 *   - Realistic personal-vault content across work / social / cloud /
 *     finance / dev / shopping / utilities so a first-time visitor
 *     sees the kind of breadth their own vault would have.
 *   - Mix of entry icons so the icon picker preview is not monotone.
 *   - One entry with TOTP, one with a notes field, one with a custom
 *     field — keeps the details pane from looking empty.
 */
import * as kdbxweb from '../../db/lib';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { argon2 } from '../../db/test/test-support/argon2';

interface DemoEntry {
    title: string;
    user: string;
    pass: string;
    url?: string;
    notes?: string;
    icon: number;
    tags: string[];
    totp?: string;
    custom?: Record<string, string>;
}

async function createDemoDb() {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);

    const password = kdbxweb.ProtectedValue.fromString('demo');
    const cred = new kdbxweb.Credentials(password);
    const db = kdbxweb.Kdbx.create(cred, 'Demo');

    db.upgrade();
    db.setKdf(kdbxweb.Consts.KdfId.Argon2id);

    const root = db.getDefaultGroup();
    root.name = 'Demo';

    function addEntry(group: kdbxweb.KdbxGroup, e: DemoEntry): void {
        const entry = db.createEntry(group);
        entry.fields.set('Title', e.title);
        entry.fields.set('UserName', e.user);
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(e.pass));
        if (e.url) entry.fields.set('URL', e.url);
        if (e.notes) entry.fields.set('Notes', e.notes);
        if (e.totp) {
            entry.fields.set(
                'otp',
                kdbxweb.ProtectedValue.fromString(
                    `otpauth://totp/${encodeURIComponent(e.title)}?secret=${e.totp}&issuer=${encodeURIComponent(e.title)}`
                )
            );
        }
        if (e.custom) {
            for (const [k, v] of Object.entries(e.custom)) {
                entry.fields.set(k, v);
            }
        }
        entry.icon = e.icon;
        entry.tags = e.tags;
    }

    // --- Group: Work ---
    const work = db.createGroup(root, 'Work');
    work.icon = 35; // wrench

    addEntry(work, {
        title: 'GitHub',
        user: 'demouser',
        pass: 'Gh!tHub$ecure99',
        url: 'https://github.com',
        icon: 1,
        tags: ['work', 'dev', '2fa'],
        totp: 'JBSWY3DPEHPK3PXP'
    });
    addEntry(work, {
        title: 'AWS Console',
        user: 'iam-demouser',
        pass: 'aws.demo.K3y!',
        url: 'https://console.aws.amazon.com',
        notes: 'account 123456789012',
        icon: 3,
        tags: ['work', 'cloud', 'admin']
    });
    addEntry(work, {
        title: 'Slack — Acme',
        user: 'demo@acme.com',
        pass: 'Sl@ck!Acme24',
        url: 'https://acme.slack.com',
        icon: 5,
        tags: ['work', 'social']
    });
    addEntry(work, {
        title: 'Jira',
        user: 'demo@acme.com',
        pass: 'J1raDemoP@ss',
        url: 'https://acme.atlassian.net',
        icon: 32,
        tags: ['work']
    });
    addEntry(work, {
        title: 'PagerDuty',
        user: 'oncall@acme.com',
        pass: 'P@geMe!2024',
        url: 'https://acme.pagerduty.com',
        icon: 24,
        tags: ['work', 'admin']
    });

    // --- Group: Personal ---
    const personal = db.createGroup(root, 'Personal');
    personal.icon = 9;

    addEntry(personal, {
        title: 'Gmail',
        user: 'demo.user@gmail.com',
        pass: 'Gm@il.D3mo.99',
        url: 'https://mail.google.com',
        icon: 19,
        tags: ['email', 'personal', '2fa'],
        totp: 'JBSWY3DPEHPK3PXP',
        custom: { 'Backup codes': '4f7a-9b21\n8e3c-1d05\n2a6f-7c84' }
    });
    addEntry(personal, {
        title: 'ProtonMail',
        user: 'demo@protonmail.com',
        pass: 'Pr0t0n!D3m0',
        url: 'https://mail.proton.me',
        icon: 19,
        tags: ['email', 'personal']
    });
    addEntry(personal, {
        title: 'Apple ID',
        user: 'demo.user@icloud.com',
        pass: 'Appl3.D3m0!Id',
        url: 'https://appleid.apple.com',
        icon: 27,
        tags: ['personal', 'cloud', '2fa']
    });
    addEntry(personal, {
        title: 'Reddit',
        user: 'demo_redditor',
        pass: 'R3dd!tP@ss',
        url: 'https://www.reddit.com',
        icon: 1,
        tags: ['social', 'personal']
    });
    addEntry(personal, {
        title: 'X (Twitter)',
        user: '@demouser',
        pass: 'X.tw!t.D3mo24',
        url: 'https://x.com',
        icon: 1,
        tags: ['social', 'personal']
    });

    // --- Group: Finance ---
    const finance = db.createGroup(root, 'Finance');
    finance.icon = 37;

    addEntry(finance, {
        title: 'Demo Bank',
        user: 'demo_customer',
        pass: 'B@nk!ng2024',
        url: 'https://www.example-bank.com',
        notes: 'customer 12345678',
        icon: 37,
        tags: ['finance', 'banking', '2fa']
    });
    addEntry(finance, {
        title: 'Coinbase',
        user: 'demo@example.com',
        pass: 'C01nb@s3!Demo',
        url: 'https://www.coinbase.com',
        icon: 37,
        tags: ['finance', 'crypto', '2fa']
    });
    addEntry(finance, {
        title: 'IRS · Personal Tax',
        user: 'demo.user',
        pass: 'T@xes2024!',
        url: 'https://www.irs.gov',
        icon: 18,
        tags: ['finance', 'archive']
    });

    // --- Group: Cloud & Storage ---
    const cloud = db.createGroup(root, 'Cloud');
    cloud.icon = 27;

    addEntry(cloud, {
        title: 'Dropbox',
        user: 'demo@example.com',
        pass: 'Dr0pB0x!Demo',
        url: 'https://www.dropbox.com',
        icon: 27,
        tags: ['cloud', 'personal', 'sync']
    });
    addEntry(cloud, {
        title: 'Google Drive',
        user: 'demo.user@gmail.com',
        pass: 'G.Dr1ve!Demo24',
        url: 'https://drive.google.com',
        icon: 27,
        tags: ['cloud', 'personal', 'sync']
    });
    addEntry(cloud, {
        title: 'Backblaze B2',
        user: 'demouser-b2',
        pass: 'B2.Backup.Demo!',
        url: 'https://www.backblaze.com',
        notes: 'bucket: demo-backups',
        icon: 27,
        tags: ['cloud', 'backup']
    });

    // --- Group: Shopping ---
    const shopping = db.createGroup(root, 'Shopping');
    shopping.icon = 37;

    addEntry(shopping, {
        title: 'Amazon',
        user: 'demo.shopper@example.com',
        pass: 'Am@z0n!Sh0p',
        url: 'https://www.amazon.com',
        icon: 37,
        tags: ['shopping', 'personal']
    });
    addEntry(shopping, {
        title: 'eBay',
        user: 'demo_buyer',
        pass: 'EB@y!Demo24',
        url: 'https://www.ebay.com',
        icon: 37,
        tags: ['shopping', 'personal']
    });

    // --- Group: Utilities ---
    const utils = db.createGroup(root, 'Utilities');
    utils.icon = 14;

    addEntry(utils, {
        title: 'Home WiFi',
        user: 'admin',
        pass: 'WiFi-P@ss-2024!',
        url: 'http://192.168.1.1',
        notes: 'SSID HomeNetwork (TP-Link Archer)',
        icon: 12,
        tags: ['network', 'home']
    });
    addEntry(utils, {
        title: 'Synology NAS',
        user: 'admin',
        pass: 'N@s.Adm1n!2024',
        url: 'http://192.168.1.10:5000',
        icon: 27,
        tags: ['network', 'home', 'admin']
    });
    addEntry(utils, {
        title: 'Comcast / Xfinity',
        user: 'demo@comcast.net',
        pass: 'X.Fin!ty.Demo',
        url: 'https://customer.xfinity.com',
        icon: 12,
        tags: ['utilities', 'home']
    });

    db.createRecycleBin();

    const data = await db.save();
    const outputPath = resolve(__dirname, '../app/resources/Demo.kdbx');
    writeFileSync(outputPath, Buffer.from(data));

    const allTags = new Set<string>();
    db.getDefaultGroup()
        .allEntries()
        .forEach((e) => e.tags.forEach((t) => allTags.add(t)));

    console.log(`Demo database written: ${outputPath}`);
    console.log(`Format:    KDBX ${db.header.versionMajor}.${db.header.versionMinor}`);
    console.log(`Groups:    ${db.getDefaultGroup().groups.length} + recycle bin`);
    console.log(`Entries:   ${db.getDefaultGroup().allEntries().length}`);
    console.log(`Tags (${allTags.size}): ${[...allTags].sort().join(', ')}`);
    console.log(`Password:  "demo"`);

    // Verify roundtrip.
    const readData = new Uint8Array(data).buffer;
    const readDb = await kdbxweb.Kdbx.load(
        readData,
        new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('demo'))
    );
    console.log(`Verified:  ${readDb.meta.name} v${readDb.header.versionMajor} loads`);

    kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
}

createDemoDb().catch((err) => {
    console.error('Failed to create demo database:', err);
    process.exit(1);
});
