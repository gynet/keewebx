const path = require('path');
const webpack = require('../../modules/ui/node_modules/webpack');
const create = require('../../modules/ui/webpack.config.js');
module.exports = (env, argv) => {
    const config = create(env, argv);
    config.context = path.resolve(__dirname, '../../modules/ui');
    config.resolveLoader = {modules: [path.resolve(__dirname, '../../modules/ui/node_modules'), 'node_modules']};
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^hooks\/init$/, path.join(__dirname, 'fixture/init.tsx')));
    return config;
};
