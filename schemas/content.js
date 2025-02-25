/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

/**
 * A content created by a wysiwyg editor
 */
const schema = mongoose.Schema({
  raw: { type: String }, // raw text content
  json: { type: String }, // the content stored in json string
  html: { type: String },
});

schema.index({ raw: "text" });

module.exports = { schema };
