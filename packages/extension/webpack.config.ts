/* eslint-disable import/no-namespace */
import * as path from 'path';
import * as fs from 'fs';
import merge from 'merge';
import * as CopyPlugin from 'copy-webpack-plugin';
import { DefinePlugin } from 'webpack';

const dev = process.argv.includes('--mode=development');

const knownBrowsers = new Set(['chrome', 'firefox', 'edge']);

const browser = process.env.KW_BROWSER || 'chrome';
// Builds the variant that ships the full app inside the extension.
const vault = process.env.KW_VAULT === '1';
if (!knownBrowsers.has(browser)) {
    throw new Error(`Unknown browser: ${browser}`);
}

// eslint-disable-next-line import/no-default-export,no-restricted-syntax
export default {
    entry: {
        'background': './src/background/init.ts',
        'content-keeweb': './src/content/content-keeweb.ts',
        'content-page': './src/content/content-page.ts',
        'options': './src/options/index.tsx',
        ...(vault ? { popup: './src/popup/index.tsx', settings: './src/settings/index.tsx' } : {})
    },
    output: {
        filename: 'js/[name].js',
        path: path.resolve('dist', vault ? `${browser}-vault` : browser)
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: {
                    loader: 'ts-loader',
                    options: { transpileOnly: true }
                },
                exclude: /node_modules/
            },
            {
                test: /\.svg$/,
                include: /[\\/]@phosphor-icons[\\/]core[\\/]assets[\\/]/,
                type: 'asset/source'
            }
        ]
    },
    resolve: {
        alias: {
            background: path.resolve('src/background'),
            common: path.resolve('src/common'),
            content: path.resolve('src/content'),
            options: path.resolve('src/options'),
            ui: path.resolve('src/ui'),
            'ui-kit': path.resolve('../ui-kit/src')
        },
        extensions: ['.tsx', '.ts', '.js']
    },
    optimization: {
        minimize: false
    },
    plugins: [
        new DefinePlugin({ __KW_EMBEDDED_VAULT__: JSON.stringify(vault) }),
        new CopyPlugin({
            patterns: [
                { from: '_locales', to: '_locales' },
                { from: 'icons', to: 'icons' },
                { from: 'pages', to: 'pages' },
                { from: `img/${browser}`, to: 'img' },
                { from: 'styles', to: 'styles' },
                {
                    from: 'manifest.json',
                    transform: (content) => {
                        const manifest = <chrome.runtime.Manifest>JSON.parse(content.toString());
                        const patchFiles = [`manifest.${browser}.json`];
                        if (vault) {
                            patchFiles.push('manifest.vault.json');
                        }
                        if (dev) {
                            patchFiles.push('manifest.dev.json');
                        }
                        for (const patchFile of patchFiles) {
                            if (!fs.existsSync(patchFile)) {
                                continue;
                            }
                            const patchData = <chrome.runtime.Manifest>(
                                JSON.parse(fs.readFileSync(patchFile, 'utf8'))
                            );
                            merge.recursive(manifest, patchData);
                        }
                        if (vault) {
                            // Arrays are replaced by the merge, so extend this one here.
                            manifest.permissions = [
                                ...(manifest.permissions ?? []),
                                'offscreen',
                                'sidePanel',
                                'idle'
                            ];
                        }
                        // Firefox MV3 does not accept background.service_worker
                        // (that's a Chrome-specific key). It uses background
                        // .scripts. Deep-merge alone can't drop the Chrome key,
                        // so we post-process the background section here for
                        // firefox. Symptom when this is missing: Firefox refuses
                        // the xpi with a "corrupted" error on install.
                        if (browser === 'firefox') {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const bg = (manifest as any).background;
                            if (bg?.service_worker) {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                (manifest as any).background = {
                                    scripts: [bg.service_worker]
                                };
                            }
                        }
                        const str = JSON.stringify(manifest, null, 2);
                        content = Buffer.from(str, 'utf8');
                        return content;
                    }
                }
            ]
        })
    ]
};
