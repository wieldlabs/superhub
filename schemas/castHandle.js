/* eslint-disable no-inline-comments */
const mongoose = require("mongoose");

// generate a mongoose schema for an API key
const schema = mongoose.Schema(
  {
    handle: { type: String, required: true, unique: true }, // e.g. op_test, test, base_test - has to be unique
    owner: { type: String, required: true }, // lowercase address
    chain: { type: String, enum: ["ETH", "OP", "BASE"], required: true },
    tokenId: {
      type: String,
      required: true,
      unique: true,
      validate: {
        validator: function (v) {
          return (
            typeof v === "string" &&
            v.length > 0 &&
            v.startsWith("0x") &&
            !v.toLowerCase().startsWith("0x0") // needs to be normalized (CastHandle.normalizeTokenId)
          );
        },
        message: (props) =>
          `${props.value} is not a valid tokenId (string, starts with 0x, not 0x0)`,
      },
    }, // tokenId's must be unique across all chains
    expiresAt: { type: Number },
    displayItemId: {
      type: String,
    }, // for indexing if displaying other than handle default image
    displayMetadata: {
      type: Object,
      default: {},
    },
    unsyncedMetadata: { type: Boolean, default: false },
  },
  { timestamps: true } // Note it's createdAt relative to the DB, not onchain! Add mintedAt and expiresAt if you want to track onchain
);

schema.index({ owner: 1 });
schema.index({ owner: 1, tokenId: 1 });
schema.index({ chain: 1 });
schema.index({ owner: 1, expiresAt: 1 }); // convertHandlesToPacks
schema.index({ displayItemId: 1 });
schema.index({ "displayMetadata.wear": 1 });
schema.index({ "displayMetadata.foil": 1 });
schema.index({ "displayMetadata.wear": 1, "displayMetadata.foil": 1 });
schema.index({ "displayMetadata.wear": 1, chain: 1 });
schema.index({ "displayMetadata.foil": 1, chain: 1 });
schema.index({ unsyncedMetadata: 1 });
schema.index({ unsyncedMetadata: 1, updatedAt: 1 });

module.exports = { schema };
