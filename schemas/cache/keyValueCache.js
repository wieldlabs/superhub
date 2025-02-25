/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

/** Generic key value cache */
const schema = mongoose.Schema(
  {
    key: { type: String, required: true, index: true }, // the cache key
    value: { type: String },
    expiresAt: { type: Date }, // the cache expiration date. null means no expiration
  },
  { timestamps: true }
);

schema.index({ key: 1, createdAt: -1 });

module.exports = { schema };
