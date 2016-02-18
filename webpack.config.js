var webpack = require('webpack');
module.exports = {
    entry: "./webclient/wallet.js",
    output: {
        path: __dirname,
        filename: "bundle.js"
    },
    plugins: [
        new webpack.DefinePlugin({
            PRIV_KEY: JSON.stringify(process.env.PRIV_KEY)
        })],
    module: {
        loaders: [
            {
                test: /\.js$/,
                loaders: ["babel"],
                exclude: /node_modules/
            },
            {
                test: /\.css$/,
                loader: "style!css"
            },
            {
                test: /\.json$/,
                loader: 'json-loader'
            }
        ]
    }
};