import { basename, resolve } from 'node:path';

/** Bun module mocks are process-wide; isolate files without filtering suites. */
export async function runIsolatedTests(cwd: string): Promise<void> {
    const files = Array.from(new Bun.Glob('tests/**').scanSync({ cwd, onlyFiles: true }))
        .filter((file) => /(?:[._](?:test|spec))\.[cm]?[jt]sx?$/.test(file))
        .sort();
    if (!files.length) throw new Error(`No test files found in ${cwd}`);

    const failed: string[] = [];
    for (const file of files) {
        const child = Bun.spawn([process.execPath, 'test', `./${file}`], {
            cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
        });
        if ((await child.exited) !== 0) failed.push(file);
    }
    console.log(`${basename(cwd)} test files: ${files.length - failed.length} passed, ${failed.length} failed`);
    for (const file of failed) console.error(`Failed: ${file}`);
    if (failed.length) process.exitCode = 1;
}

if (import.meta.main) await runIsolatedTests(resolve(process.argv[2] || process.cwd()));
