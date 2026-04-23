const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const rootDir = __dirname;
const pkg = require('./package.json');

// Generate SCSS variables for WhiteSur icons (SVG → base64 data URI)
function generateWhiteSurScssVars() {
    const whitesurDir = path.join(rootDir, 'app/icons/whitesur');
    let vars = '';
    if (fs.existsSync(whitesurDir)) {
        for (const file of fs.readdirSync(whitesurDir).filter((f) => f.endsWith('.svg'))) {
            const b64 = fs.readFileSync(path.join(whitesurDir, file)).toString('base64');
            const varName = file.replace(/\.svg$/, '').replace(/[^a-zA-Z0-9]/g, '-');
            vars += `$ws-icon-${varName}: url('data:image/svg+xml;base64,${b64}');\n`;
        }
    }
    return vars;
}
const whitesurScssVars = generateWhiteSurScssVars();
if (whitesurScssVars) {
    const varNames = whitesurScssVars.match(/\$ws-icon-[\w-]+/g) || [];
    console.log(`[WhiteSur] Generated ${varNames.length} icon variables: ${varNames.join(', ')}`);
} else {
    console.error('[WhiteSur] WARNING: No icon variables generated!');
}

process.noDeprecation = true;

// Resolve a verifiable build identity so code = build = demo = test cannot
// silently drift apart. Prefers the CI-provided commit SHA; falls back to
// whatever HEAD is in the working tree; finally 'unknown' if git is gone.
const gitSha =
    process.env.GITHUB_SHA ||
    process.env.GIT_SHA ||
    (() => {
        try {
            return execSync('git rev-parse HEAD', { cwd: rootDir })
                .toString()
                .trim();
        } catch {
            return 'unknown';
        }
    })();
const gitShaShort = gitSha.slice(0, 7);
const buildTime = new Date().toISOString();

module.exports = (env, argv) => {
    const mode = argv.mode || 'development';
    const devMode = mode === 'development';

    const dt = new Date().toISOString().replace(/T.*/, '');
    const year = new Date().getFullYear();

    return {
        mode,
        entry: {
            app: path.join(rootDir, 'app/scripts/app.ts')
        },
        output: {
            path: path.resolve(rootDir, 'dist'),
            filename: 'js/[name].js',
            clean: true
        },
        target: 'web',
        performance: {
            hints: false
        },
        resolve: {
            extensions: ['.ts', '.js', '.json', '.hbs'],
            modules: [
                path.join(rootDir, 'app/scripts'),
                path.join(rootDir, 'app/styles'),
                path.join(rootDir, 'node_modules'),
                path.join(rootDir, '../../node_modules')
            ],
            alias: {
                // Module aliases matching app/scripts/ directories
                comp: path.join(rootDir, 'app/scripts/comp'),
                models: path.join(rootDir, 'app/scripts/models'),
                views: path.join(rootDir, 'app/scripts/views'),
                util: path.join(rootDir, 'app/scripts/util'),
                storage: path.join(rootDir, 'app/scripts/storage'),
                framework: path.join(rootDir, 'app/scripts/framework'),
                const: path.join(rootDir, 'app/scripts/const'),
                collections: path.join(rootDir, 'app/scripts/collections'),
                presenters: path.join(rootDir, 'app/scripts/presenters'),
                locales: path.join(rootDir, 'app/scripts/locales'),
                hooks: path.join(rootDir, 'app/scripts/hooks'),
                'hbs-helpers': path.join(rootDir, 'app/scripts/hbs-helpers'),

                // Template and resource aliases
                templates: path.join(rootDir, 'app/templates'),
                'public-key.pem': path.join(rootDir, 'app/resources/public-key.pem'),
                'public-key-new.pem': path.join(rootDir, 'app/resources/public-key-new.pem'),
                'demo.kdbx': path.join(rootDir, 'app/resources/Demo.kdbx'),

                // Library aliases
                jquery: `jquery/dist/jquery${devMode ? '' : '.min'}.js`,
                morphdom: `morphdom/dist/morphdom-umd${devMode ? '' : '.min'}.js`,
                // `kdbxweb` is a workspace alias to @keewebx/db (see
                // packages/core/package.json). No webpack alias needed —
                // bun install materialises the workspace package at
                // packages/core/node_modules/kdbxweb pointing at
                // packages/db, and webpack resolves the bare specifier
                // via the `main` field (packages/db/dist/kdbxweb.js).
                baron: `baron/baron${devMode ? '' : '.min'}.js`,
                qrcode: `jsqrcode/dist/qrcode${devMode ? '' : '.min'}.js`,
                argon2: 'argon2-browser/dist/argon2.js',
                marked: devMode ? 'marked/lib/marked.js' : 'marked/marked.min.js',
                dompurify: `dompurify/dist/purify${devMode ? '' : '.min'}.js`,
                tweetnacl: `tweetnacl/nacl${devMode ? '' : '.min'}.js`,
                hbs: 'handlebars/runtime.js',
                'argon2-wasm': 'argon2-browser/dist/argon2.wasm',
                'fontawesome.woff2':
                    '@fortawesome/fontawesome-free/webfonts/fa-regular-400.woff2'
            },
            fallback: {
                console: false,
                process: false,
                crypto: false,
                Buffer: false,
                __filename: false,
                __dirname: false,
                fs: false,
                setImmediate: false,
                path: false,
                moment: false
            }
        },
        resolveLoader: {
            modules: ['node_modules', path.join(rootDir, 'build/loaders')]
        },
        module: {
            rules: [
                // TypeScript (strict-mode migration complete, 2026-04-09:
                // packages/core now compiles at 0 errors — see
                // .typescript-baseline. transpileOnly used to be `true`
                // during the 368 -> 0 ratchet; now that the last file has
                // been typed cleanly, ts-loader performs real type checks
                // at bundle time and CI enforces the baseline via
                // .github/workflows/ci.yml typecheck job.)
                //
                // Override tsconfig's `noEmit: true` here — that flag
                // exists so `bunx tsc --noEmit` in CI (the typecheck job)
                // does a pure check without cluttering the tree with
                // compiled .js, but webpack's ts-loader needs actual
                // emit output to feed into the bundle.
                {
                    test: /\.ts$/,
                    exclude: /node_modules/,
                    use: {
                        loader: 'ts-loader',
                        options: {
                            compilerOptions: {
                                noEmit: false
                            }
                        }
                    }
                },
                // Handlebars templates
                {
                    test: /\.hbs$/,
                    use: [
                        {
                            loader: 'handlebars-loader',
                            options: {
                                knownHelpers: fs
                                    .readdirSync(
                                        path.join(rootDir, 'app/scripts/hbs-helpers')
                                    )
                                    .map((f) => f.replace(/\.(js|ts)$/, ''))
                                    .filter((f) => f !== 'index'),
                                partialResolver(partial, callback) {
                                    const location = path.join(
                                        rootDir,
                                        'app/templates/partials',
                                        `${partial}.hbs`
                                    );
                                    callback(null, location);
                                }
                            }
                        },
                        {
                            loader: 'string-replace-loader',
                            options: {
                                search: /\r?\n\s*/g,
                                replace: '\n'
                            }
                        }
                    ]
                },
                // Runtime info string replacements.
                // NOTE: this MUST match both .js and .ts. The TS migration
                // (commit 9cc7e23c) renamed runtime-info.js → runtime-info.ts
                // but this regex was not updated, so for ~5 months every
                // bundle shipped with @@VERSION / @@DATE / @@COMMIT as
                // literal placeholders. The KeeWeb Connect browser extension
                // saw `version: "@@VERSION"` in the protocol response and
                // silently rejected the autofill (it expects a real semver
                // version), making autofill appear broken on the demo even
                // though the protocol layer was working. Found 2026-04-09.
                {
                    test: /runtime-info\.[jt]s$/,
                    loader: 'string-replace-loader',
                    options: {
                        multiple: [
                            {
                                search: /@@VERSION/g,
                                replace: pkg.version
                            },
                            {
                                search: /@@BETA/g,
                                replace: ''
                            },
                            { search: /@@DATE/g, replace: dt },
                            {
                                search: /@@COMMIT/g,
                                replace: 'dev'
                            },
                            { search: /@@DEVMODE/g, replace: devMode ? '1' : '' },
                            { search: /@@APPLE_TEAM_ID/g, replace: '' }
                        ]
                    }
                },
                // Baron scrollbar library
                {
                    test: /baron(\.min)?\.js$/,
                    use: [
                        {
                            loader: 'string-replace-loader',
                            options: {
                                search: /\(1,\s*eval\)\('this'\)/g,
                                replace: 'window'
                            }
                        },
                        {
                            loader: 'exports-loader',
                            options: {
                                type: 'module',
                                exports: 'default baron'
                            }
                        }
                    ]
                },
                // Handlebars source map stripping
                { test: /handlebars/, loader: 'strip-sourcemap-loader' },
                // Argon2 special handling
                {
                    test: /argon2\.wasm/,
                    type: 'javascript/auto',
                    loader: 'base64-loader'
                },
                { test: /argon2(\.min)?\.js/, loader: 'raw-loader' },
                // SCSS/CSS
                {
                    test: /\.s?css$/,
                    use: [
                        MiniCssExtractPlugin.loader,
                        { loader: 'css-loader', options: { sourceMap: devMode } },
                        { loader: 'postcss-loader', options: { sourceMap: devMode } },
                        { loader: 'sass-loader', options: { sourceMap: devMode, additionalData: whitesurScssVars } },
                        { loader: 'scss-add-icons-loader' }
                    ]
                },
                // Font Awesome custom font builder
                { test: /fontawesome.*\.woff2$/, loader: 'fontawesome-loader' },
                // Raw files
                { test: /\.pem$/, loader: 'raw-loader' },
                { test: /\.kdbx$/, loader: 'base64-loader' }
            ]
        },
        plugins: [
            new webpack.BannerPlugin(
                'keewebx v' +
                    pkg.version +
                    ', (c) ' +
                    year +
                    ' ' +
                    (typeof pkg.author === 'string' ? pkg.author : pkg.author.name) +
                    ', opensource.org/licenses/' +
                    pkg.license +
                    ' [' +
                    gitShaShort +
                    ' @ ' +
                    buildTime +
                    ']'
            ),
            // Inject build identity into the bundle so runtime, tests, and
            // live demo can all assert the same commit SHA. See
            // app/scripts/app.ts + e2e/live/smoke-live.spec.ts.
            new webpack.DefinePlugin({
                __KEEWEBX_BUILD_SHA__: JSON.stringify(gitSha),
                __KEEWEBX_BUILD_SHA_SHORT__: JSON.stringify(gitShaShort),
                __KEEWEBX_BUILD_TIME__: JSON.stringify(buildTime)
            }),
            new webpack.ProvidePlugin({
                $: 'jquery'
            }),
            new webpack.IgnorePlugin({ resourceRegExp: /^(moment)$/ }),
            new MiniCssExtractPlugin({
                filename: 'css/[name].css'
            }),
            new HtmlWebpackPlugin({
                template: path.join(rootDir, 'app/index.html'),
                inject: false
            }),
            new CopyWebpackPlugin({
                patterns: [
                    { from: path.join(rootDir, 'app/icons'), to: 'icons' },
                    { from: path.join(rootDir, 'app/manifest'), to: '.' }
                ]
            })
        ],
        externals: {
            xmldom: 'null',
            '@xmldom/xmldom': 'null',
            crypto: 'null',
            fs: 'null',
            path: 'null'
        },
        devtool: devMode ? 'source-map' : undefined,
        devServer: {
            static: {
                directory: path.join(rootDir, 'app')
            },
            port: process.env.PORT ? Number(process.env.PORT) : 8085,
            hot: true,
            open: false,
            historyApiFallback: true,
            client: {
                overlay: false
            }
        }
    };
};
