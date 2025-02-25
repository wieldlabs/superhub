/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");
const crypto = require("crypto");

const { getRandomUint256 } = require("../helpers/get-random-uint256");

/**
 * Nonce is used to avoid repeat attack
 */
const schema = mongoose.Schema(
  {
    /** nonce for account sign in */
    nonce: { type: String, default: () => `${crypto.randomInt(1, 10000)}` },
    /** nonce for account transaction */
    transactionNonce: {
      type: String,
      default: () => `${getRandomUint256()}`,
    },
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = { schema };
