// Builds the default New interface and its next.html compatibility entry.
// Classic has explicit HTML entries and shares the same site and storage.
// Run after the Classic build, which empties dist first.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const rootDir = __dirname;
const offlineEnabled = !process.env.KEEWEBX_STORAGE_NAMESPACE;
const vaultDir = path.join(rootDir, '../vault');
const pkg = require('./package.json');
const extraSource = process.env.KEEWEBX_EXTRA_SOURCE_DIR;
const gitSha = process.env.GITHUB_SHA || process.env.GIT_SHA || (() => {
    try { return execSync('git rev-parse HEAD', { cwd: rootDir }).toString().trim(); }
    catch { return 'unknown'; }
})();
const buildTime = new Date().toISOString();

module.exports = (env, argv) => {
    const mode = argv.mode || 'development';
    const devMode = mode === 'development';
    return {
        mode,
        entry: { next: path.join(rootDir, 'src/index.tsx'),
            'connect-port-poc/relay': path.join(rootDir, 'connect-port-poc/relay.js'),
            'connect-port-poc/worker': path.join(rootDir, 'connect-port-poc/worker.js'),
            'connect-port/relay': path.join(rootDir, 'connect-port/relay.js'),
            'connect-port/worker': path.join(rootDir, 'connect-port/worker.js') },
        output: {
            path: path.resolve(rootDir, '../../dist'),
            filename: data => /^connect-port(?:-poc)?\//.test(data.chunk.name) ? '[name].js' : 'js/[name].js',
            clean: false
        },
        target: 'web',
        devServer: {
            host: '127.0.0.1',
            port: Number(process.env.PORT || 8085),
            static: { directory: path.resolve(rootDir, '../../dist') },
            open: false,
            historyApiFallback: false
        },
        performance: { hints: false },
        resolve: {
            extensions: ['.tsx', '.ts', '.js', '.json'],
            // This package's own folders first, then the vault package.
            modules: [
                ...(extraSource ? [path.resolve(extraSource)] : []),
                path.join(rootDir, 'src'),
                path.join(rootDir, '../vault/src'),
                path.join(rootDir, 'node_modules'),
                path.join(rootDir, '../../node_modules'),
                'node_modules'
            ],
            alias: {
                app: path.join(rootDir, 'src'),
                'ui-kit': path.join(rootDir, '../ui-kit/src'),
                boot: path.join(rootDir, '../vault/src/boot.ts'),
                'demo.kdbx': path.join(vaultDir, 'resources/Demo.kdbx'),
                'public-key.pem': path.join(vaultDir, 'resources/public-key.pem'),
                'public-key-new.pem': path.join(vaultDir, 'resources/public-key-new.pem'),
                argon2: 'hash-wasm/dist/argon2.umd.min.js'
            },
            fallback: { crypto: false, fs: false, path: false, process: false, Buffer: false }
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    exclude: /node_modules/,
                    use: {
                        loader: 'ts-loader',
                        options: {
                            transpileOnly: true,
                            configFile: path.join(rootDir, 'tsconfig.json'),
                            compilerOptions: { noEmit: false }
                        }
                    }
                },
                {
                    test: /runtime-info\.[jt]s$/,
                    loader: 'string-replace-loader',
                    options: {
                        multiple: [
                            { search: /@@VERSION/g, replace: pkg.version },
                            { search: /@@BETA/g, replace: '' },
                            { search: /@@DATE/g, replace: new Date().toISOString().replace(/T.*/, '') },
                            { search: /@@COMMIT/g, replace: gitSha.slice(0, 7) },
                            { search: /@@DEVMODE/g, replace: devMode ? '1' : '' },
                            { search: /@@APPLE_TEAM_ID/g, replace: '' }
                        ]
                    }
                },
                { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
                {
                    test: /\.svg$/,
                    include: /[\\/]@phosphor-icons[\\/]core[\\/]assets[\\/]/,
                    type: 'asset/source'
                },
                { test: /argon2\.umd\.min\.js$/, loader: 'raw-loader' },
                { test: /\.pem$/, loader: 'raw-loader' },
                { test: /\.kdbx$/, loader: 'base64-loader' }
            ]
        },
        plugins: [
            new webpack.DefinePlugin({
                __KW_STORAGE_NAMESPACE__: JSON.stringify(process.env.KEEWEBX_STORAGE_NAMESPACE || ''),
                __KW_NEW_EXTENSION__: process.env.KEEWEBX_NEW_EXTENSION !== '0',
                __KEEWEBX_BUILD_SHA__: JSON.stringify(gitSha),
                __KEEWEBX_BUILD_SHA_SHORT__: JSON.stringify(gitSha.slice(0, 7)),
                __KEEWEBX_BUILD_TIME__: JSON.stringify(buildTime)
            }),
            new MiniCssExtractPlugin({ filename: 'css/[name].css' }),
            ...['index.html', 'next.html'].map(filename => new HtmlWebpackPlugin({
                template: path.join(rootDir, 'src/next.html'),
                templateParameters: { offlineEnabled, manifest: filename === 'index.html' ? 'manifest.json' : 'manifest-new.json' },
                filename,
                chunks: ['next'],
                inject: 'body',
                publicPath: ''
            })),
            new HtmlWebpackPlugin({
                template: path.join(rootDir, 'connect.html'),
                filename: 'connect.html',
                inject: false,
                chunks: []
            }),
            new HtmlWebpackPlugin({
                template: path.join(rootDir, 'connect-port-poc/relay.html'),
                filename: 'connect-port-poc/relay.html',
                inject: false,
                chunks: []
            }),
            new HtmlWebpackPlugin({ template: path.join(rootDir, 'connect-port/relay.html'), filename: 'connect-port/relay.html', inject: false, chunks: [] }),
            { apply(compiler) {
                compiler.hooks.thisCompilation.tap('PortPocInstaller', compilation => {
                    compilation.hooks.processAssets.tap({ name: 'PortPocInstaller', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL }, () => {
                        compilation.emitAsset('connect-port/keewebx-connect.user.js', new webpack.sources.RawSource(
                            fs.readFileSync(path.join(rootDir, '../extension/userscript/keewebx-connect.user.js'))), { minimized: true });
                        compilation.emitAsset('connect-port-poc/keewebx-messageport-poc.user.js', new webpack.sources.RawSource(
                            fs.readFileSync(path.join(rootDir, '../extension/userscript/keewebx-messageport-poc.user.js'))), { minimized: true });
                    });
                });
            } },
        ],
        externals: { xmldom: 'null', '@xmldom/xmldom': 'null', crypto: 'null', fs: 'null', path: 'null' },
        devtool: devMode ? 'source-map' : undefined
    };
};
