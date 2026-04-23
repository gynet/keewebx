/* eslint-disable import/no-namespace */
import * as path from 'path';
import * as fs from 'fs';
import merge from 'merge';
import * as CopyPlugin from 'copy-webpack-plugin';

const dev = process.argv.includes('--mode=development');

const knownBrowsers = new Set(['chrome', 'firefox', 'edge']);

const browser = process.env.KW_BROWSER || 'chrome';
if (!knownBrowsers.has(browser)) {
    throw new Error(`Unknown browser: ${browser}`);
}

// eslint-disable-next-line import/no-default-export,no-restricted-syntax
export default {
    entry: {
        'background': './src/background/init.ts',
        'content-keeweb': './src/content/content-keeweb.ts',
        'content-page': './src/content/content-page.ts',
        'options': './src/options/index.tsx'
    },
    output: {
        filename: 'js/[name].js',
        path: path.resolve('dist', browser)
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
            }
        ]
    },
    resolve: {
        alias: {
            background: path.resolve('src/background'),
            common: path.resolve('src/common'),
            content: path.resolve('src/content'),
            options: path.resolve('src/options')
        },
        extensions: ['.tsx', '.ts', '.js']
    },
    optimization: {
        minimize: false
    },
    plugins: [
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
