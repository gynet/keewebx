// Builds the new interface into the app's dist folder as next.html, next to
// the Classic app (index.html), so both share one site and one storage.
// Run after the Classic build, which empties dist first.
const path = require('path');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const rootDir = __dirname;
const coreDir = path.join(rootDir, '../core');
const pkg = require('../core/package.json');

module.exports = (env, argv) => {
    const mode = argv.mode || 'development';
    const devMode = mode === 'development';
    return {
        mode,
        entry: { next: path.join(rootDir, 'src/index.tsx') },
        output: {
            path: path.join(coreDir, 'dist'),
            filename: 'js/[name].js',
            clean: false
        },
        target: 'web',
        performance: { hints: false },
        resolve: {
            extensions: ['.tsx', '.ts', '.js', '.json'],
            // This package's own folders first, then the vault package.
            modules: [
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
                'demo.kdbx': path.join(coreDir, 'app/resources/Demo.kdbx'),
                'public-key.pem': path.join(coreDir, 'app/resources/public-key.pem'),
                'public-key-new.pem': path.join(coreDir, 'app/resources/public-key-new.pem'),
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
                            { search: /@@COMMIT/g, replace: '' },
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
                __KW_STORAGE_NAMESPACE__: JSON.stringify(process.env.KEEWEBX_STORAGE_NAMESPACE || '')
            }),
            new MiniCssExtractPlugin({ filename: 'css/[name].css' }),
            new HtmlWebpackPlugin({
                template: path.join(rootDir, 'src/next.html'),
                filename: 'next.html',
                inject: 'body',
                publicPath: ''
            }),
        ],
        externals: { xmldom: 'null', '@xmldom/xmldom': 'null', crypto: 'null', fs: 'null', path: 'null' },
        devtool: devMode ? 'source-map' : undefined
    };
};
