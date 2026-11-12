import { resolve } from 'node:path';

// Classic tests replace shared modules with process-wide Bun mocks. A fresh
// process per file prevents those replacements from reaching another suite.
const cwd = resolve(import.meta.dir, '../modules/ui-classic');
const files = Array.from(new Bun.Glob('tests/**').scanSync({ cwd, onlyFiles: true }))
    .filter((file) => /(?:[._](?:test|spec))\.[cm]?[jt]sx?$/.test(file))
    .sort();

if (!files.length) {
    throw new Error('No Classic test files found');
}

const failed: string[] = [];
for (const file of files) {
    const child = Bun.spawn([process.execPath, 'test', `./${file}`], {
        cwd,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit'
    });
    if ((await child.exited) !== 0) {
        failed.push(file);
    }
}

console.log(`Classic test files: ${files.length - failed.length} passed, ${failed.length} failed`);
for (const file of failed) {
    console.error(`Failed: ${file}`);
}
process.exitCode = failed.length ? 1 : 0;
