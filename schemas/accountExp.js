/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

const portfolioSchema = mongoose.Schema({
  NFTScore: { type: String }, // the portfolio's NFT score, in ETH
  NFTScoreUSD: { type: String }, // the portfolio's NFT score, in USD
  tokenScore: { type: String }, // the portfolio's token score, in ETH
  walletScore: { type: String }, // the portfolio's wallet score, in ETH
  updatedAt: { type: String },
});

/** The reputation for an account */
const schema = mongoose.Schema(
  {
    exp: { type: Number, default: 0, required: true }, // the additional exp
    baseExp: { type: Number, default: 0, required: true }, // the base exp
    portfolio: [portfolioSchema], // the portfolio timeline
    account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = { schema };
