/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

const schema = mongoose.Schema({
  chainId: { type: Number }, // the chain id
  name: { type: String }, // the chain's name i.e Ethereum mainnet
});

module.exports = { schema };
