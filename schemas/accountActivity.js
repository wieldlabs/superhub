/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

const schema = mongoose.Schema({
  lastSeen: { type: Date, default: () => new Date() }, // last time the account logged in
  isWhitelisted: { type: Boolean, default: false }, // if account is whitelisted
  isOnboarded: { type: Boolean, default: false }, // if account has completed the onboarding
  isEmailVerified: { type: Boolean, default: false }, // if account has email verified
});

module.exports = { schema };
