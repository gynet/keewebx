import { resolve } from 'node:path';
import { runIsolatedTests } from './test-isolated';

await runIsolatedTests(resolve(import.meta.dir, '../modules/ui-classic'));
