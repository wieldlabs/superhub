/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

const { schema: chainSchema } = require("./chain");

const schema = mongoose.Schema({
  address: { type: String, unique: true, required: true }, // the public address
  chain: chainSchema, // the chain associated with the address (e.g. ETH, BSC, PassKey, etc.)
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Account",
    index: true,
  },
  passKeyId: {
    type: String,
  }, // used in PassKey
  counter: { type: Number, default: 0 }, // used in PassKey
});

module.exports = { schema };
