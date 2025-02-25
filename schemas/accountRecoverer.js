/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

const challengeSchema = mongoose.Schema({
  // should be encoded in base 64
  challenge: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // default to 1 week from now
  }, // the cache expiration date. Null means no expiration
});

const schema = mongoose.Schema({
  type: {
    type: String,
    enum: ["PASSKEY", "FARCASTER_SIGNER", "FARCASTER_SIGNER_EXTERNAL"], // add more e.g. social accounts that can recover the account,
  },
  // the identifier of the recoverer, e.g. the passkeyId of the recoverer
  id: {
    type: String,
    index: true,
  },
  // the public key of the recoverer, e.g. the pubKey of the passkey
  pubKey: {
    type: String,
  },
  // only used in PassKey
  counter: {
    type: Number,
    default: 0,
  },
  // used in wallet signers with email
  encyrptedWalletJson: {
    type: String,
  },
  // only used in PassKey
  challenge: challengeSchema,
});

module.exports = { schema };
