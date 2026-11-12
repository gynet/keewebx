const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const rootDir = __dirname;
const pkg = require('./package.json');

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
            app: path.join(rootDir, 'app/scripts/app.ts'),
            'service-worker': path.join(rootDir, 'app/sw/service-worker.ts')
        },
        output: {
            path: path.resolve(rootDir, '../../dist'),
            // The service worker must sit at the root so its scope covers the app.
            filename: (pathData) =>
                pathData.chunk.name === 'service-worker' ? '[name].js' : 'js/[name].js',
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
                path.join(rootDir, '../vault/src'),
                path.join(rootDir, 'app/styles'),
                path.join(rootDir, 'node_modules'),
                path.join(rootDir, '../../node_modules')
            ],
            alias: {
                // Folders only the interface has. Shared folder names (comp,
                // util, framework, models...) resolve through `modules`
                // above: this app's own folder first, then the vault package.
                views: path.join(rootDir, 'app/scripts/views'),
                presenters: path.join(rootDir, 'app/scripts/presenters'),
                'hbs-helpers': path.join(rootDir, 'app/scripts/hbs-helpers'),

                // Template and resource aliases
                templates: path.join(rootDir, 'app/templates'),
                'public-key.pem': path.join(rootDir, '../vault/resources/public-key.pem'),
                'public-key-new.pem': path.join(rootDir, '../vault/resources/public-key-new.pem'),
                'demo.kdbx': path.join(rootDir, '../vault/resources/Demo.kdbx'),

                // Library aliases
                jquery: `jquery/dist/jquery${devMode ? '' : '.min'}.js`,
                morphdom: `morphdom/dist/morphdom-umd${devMode ? '' : '.min'}.js`,
                // `kdbxweb` is a workspace alias to @keewebx/db (see
                // modules/ui-classic/package.json). No webpack alias needed —
                // bun install materialises the workspace package at
                // modules/ui-classic/node_modules/kdbxweb pointing at
                // modules/db, and webpack resolves the bare specifier
                // via the `main` field (modules/db/dist/kdbxweb.js).
                baron: `baron/baron${devMode ? '' : '.min'}.js`,
                qrcode: `jsqrcode/dist/qrcode${devMode ? '' : '.min'}.js`,
                argon2: 'hash-wasm/dist/argon2.umd.min.js',
                marked: devMode ? 'marked/lib/marked.js' : 'marked/marked.min.js',
                dompurify: `dompurify/dist/purify${devMode ? '' : '.min'}.js`,
                tweetnacl: `tweetnacl/nacl${devMode ? '' : '.min'}.js`,
                hbs: 'handlebars/runtime.js',
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
                // modules/ui-classic now compiles at 0 errors — see
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
                    exclude: [/node_modules/, /app[\\/]sw[\\/]/],
                    use: {
                        loader: 'ts-loader',
                        options: {
                            compilerOptions: {
                                noEmit: false
                            }
                        }
                    }
                },
                // Service worker: compiled against the WebWorker lib, not the DOM.
                {
                    test: /app[\\/]sw[\\/].*\.ts$/,
                    use: {
                        loader: 'ts-loader',
                        options: {
                            configFile: path.join(rootDir, 'app/sw/tsconfig.json'),
                            instance: 'service-worker',
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
                                // The runtime-info comment used to literally
                                // embed 'dev' as the commit field, so the
                                // About / Help pages always lied about which
                                // build a user was on. Wire the actual short
                                // SHA we already resolved at the top of this
                                // file — code = build = demo invariant
                                // requires that About is the ground truth a
                                // user can quote in a bug report.
                                replace: gitShaShort
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
                // Argon2 worker source: embedded as a string, see kdbxweb-init.ts
                { test: /argon2\.umd\.min\.js$/, loader: 'raw-loader' },
                // SCSS/CSS
                {
                    test: /\.s?css$/,
                    use: [
                        MiniCssExtractPlugin.loader,
                        { loader: 'css-loader', options: { sourceMap: devMode } },
                        { loader: 'postcss-loader', options: { sourceMap: devMode } },
                        { loader: 'sass-loader', options: { sourceMap: devMode } },
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
                    { from: path.join(rootDir, 'app/manifest'), to: '.' },
                    { from: path.join(rootDir, '../../LICENSE'), to: 'LICENSE', toType: 'file' },
                    { from: path.join(rootDir, '../../THIRD-PARTY-LICENSES.md'), to: 'THIRD-PARTY-LICENSES.md' }
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
