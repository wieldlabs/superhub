/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

const schema = mongoose.Schema({
  farcaster: { type: mongoose.Schema.Types.ObjectId, ref: "Farcaster" },
});

module.exports = { schema };
