const mongoose = require("mongoose");
// https://mongoosejs.com/docs/advanced_schemas.html

const { schema } = require("../../schemas/cache/keyValueCache");

class KeyValueCacheClass {
  static ping() {
    console.log("model: KeyValueCacheClass");
  }

  /**
   * create a cache entry or update existing cache entry with new value and expiresAt
   * @returns Promise<AccountCommunity> || null
   */
  static async updateOrCreate({ key, value, expiresAt }) {
    return this.findOneAndUpdate(
      { key },
      { $set: { value, expiresAt } },
      { new: true, upsert: true }
    );
  }
}

schema.loadClass(KeyValueCacheClass);

const KeyValueCache =
  mongoose.models.KeyValueCache || mongoose.model("KeyValueCache", schema);

module.exports = {
  KeyValueCache,
};
