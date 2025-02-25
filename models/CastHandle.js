const mongoose = require("mongoose");
// https://mongoosejs.com/docs/advanced_schemas.html

const { schema } = require("../schemas/castHandle");

class CastHandleClass {
  static ping() {
    console.log("model: CastHandleClass");
  }

  // Always use this when working with tokenIds!
  static normalizeTokenId(tokenId) {
    // Convert to lowercase and remove leading zeros after 0x
    return tokenId.toLowerCase().replace(/0x0+/, "0x");
  }

  async setCastHandleMetadataForFarheroPacks(packType) {
    this.displayItemId =
      packType === "Premium"
        ? "booster-pack-p"
        : packType === "Collector"
        ? "booster-pack-c"
        : "booster-pack-n";

    this.displayMetadata = {
      name: `${packType} Booster Pack`,
      image:
        packType === "Premium"
          ? "/farhero/cards/genesis-booster-p.webp"
          : packType === "Collector"
          ? "/farhero/cards/genesis-booster-c.webp"
          : "/farhero/cards/genesis-booster-n.webp",
      displayType: "farpack",
      description: "Open this pack on https://far.quest/hero to get a FarHero!", // Do not change this, use overrideDescription in metadata.js
    };

    this.unsyncedMetadata = true;
    await this.save();
    return this;
  }
}

schema.loadClass(CastHandleClass);

const CastHandle =
  mongoose.models.CastHandle || mongoose.model("CastHandle", schema);

module.exports = {
  CastHandle,
};
