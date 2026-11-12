import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Resolve aliases using the same TypeScript configuration as each interface.
const require = createRequire(new URL('../packages/ui/package.json', import.meta.url));
const ts: typeof import('../packages/ui/node_modules/typescript') = require('typescript');
const root = path.resolve(import.meta.dir, '..');
const packages = ['ui-classic', 'ui', 'vault', 'ui-kit', 'db'] as const;
type Package = typeof packages[number];
const allowed: Record<Package, readonly Package[]> = {
    'ui-classic': ['ui-classic', 'vault', 'ui-kit', 'db'],
    ui: ['ui', 'vault', 'ui-kit', 'db'],
    vault: ['vault', 'db'],
    'ui-kit': ['ui-kit'],
    db: ['db']
};

function owner(file: string): Package | undefined {
    return packages.find((name) => file.startsWith(path.join(root, 'packages', name) + path.sep));
}

function files(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return files(file);
        return /\.(?:ts|tsx|js)$/.test(entry.name) ? [file] : [];
    });
}

let errors = 0;
let checked = 0;
for (const name of packages) {
    const directory = path.join(root, 'packages', name);
    const source = path.join(directory, name === 'ui-classic' ? 'app/scripts' : name === 'db' ? 'lib' : 'src');
    let options: import('../packages/ui/node_modules/typescript').CompilerOptions = {};
    if (name !== 'ui-kit') {
        const configPath = path.join(directory, 'tsconfig.json');
        const config = ts.readConfigFile(configPath, ts.sys.readFile);
        if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
        options = ts.parseJsonConfigFileContent(config.config, ts.sys, directory).options;
    }
    for (const file of files(source)) {
        const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node: import('../packages/ui/node_modules/typescript').Node) {
            let specifier: string | undefined;
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                specifier = node.moduleSpecifier.text;
            } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
                node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
                specifier = node.moduleReference.expression.text;
            } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
                specifier = node.argument.literal.text;
            } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0]) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                specifier = node.arguments[0].text;
            }
            if (specifier) {
                checked++;
                const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
                const target = resolved ? owner(realpathSync(resolved.resolvedFileName)) :
                    specifier.startsWith('.') ? owner(path.resolve(path.dirname(file), specifier)) :
                        packages.find((pkg) => specifier === `@keewebx/${pkg}` || specifier.startsWith(`@keewebx/${pkg}/`));
                if (target && !allowed[name].includes(target)) {
                    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
                    console.error(`${path.relative(root, file)}:${line}: ${name} must not import ${target} (${specifier})`);
                    errors++;
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(ast);
    }
}
if (errors) process.exit(1);
console.log(`Package boundaries passed (${checked} imports checked).`);
