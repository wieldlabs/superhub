/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

// generate a mongoose schema for an API key
const schema = mongoose.Schema({
  key: { type: String, required: true, unique: true },
  description: { type: String, required: true },
  multiplier: { type: Number, required: true },
  email: { type: String },
});

module.exports = { schema };
