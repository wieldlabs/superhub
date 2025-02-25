const { KeyValueCache } = require("../../models/cache/KeyValueCache");
const { Service: NormalizeCacheService } = require("./NormalizeCacheService");
const { memcache, getHash } = require("../../connectmemcache");

class CacheService extends NormalizeCacheService {
  /**
   * Dupe is a special cache that is used to create multiple values for same keys.
   * Should only be used if you need to create multiple values for same key.
   * .get() will break if you use this, since there will be multiple keys.
   */
  async setWithDupe({ key, params, value, expiresAt }) {
    const normalizedKey = this.normalize({ key, params });
    await memcache.delete(getHash(normalizedKey), {
      noreply: true,
    });

    const created = await KeyValueCache.create({
      key: normalizedKey,
      value: JSON.stringify({ value }),
      expiresAt: expiresAt || null,
    });
    await Promise.all([
      memcache.set(
        getHash(normalizedKey),
        created.value,
        expiresAt
          ? {
              lifetime: Math.floor((expiresAt - new Date()) / 1000),
            }
          : {}
      ),
      memcache.delete(`${getHash(normalizedKey)}_null`, {
        noreply: true,
      }),
    ]);
    return created;
  }

  //// NOTES
  // 1. Params needs to have the same types when you get and set - otherwise you'll have two different normalized keys! Another option is to do set({key: `test_${param}`}
  async set({ key, params, value, expiresAt }) {
    const normalizedKey = this.normalize({ key, params });
    await memcache.delete(getHash(normalizedKey), {
      noreply: true,
    });

    const updated = await KeyValueCache.updateOrCreate({
      key: normalizedKey,
      value: JSON.stringify({ value }),
      expiresAt: expiresAt || null,
    });
    await Promise.all([
      memcache.set(
        getHash(normalizedKey),
        updated.value,
        expiresAt
          ? {
              lifetime: Math.floor((expiresAt - new Date()) / 1000),
            }
          : {}
      ),
      memcache.delete(`${getHash(normalizedKey)}_null`, {
        noreply: true,
      }),
    ]);
    return updated;
  }

  async get({ key, params }) {
    const normalizedKey = this.normalize({ key, params });

    const nullData = await memcache.get(`${getHash(normalizedKey)}_null`);
    if (nullData) {
      // Lets make sure we avoid checking if we know it's null - this is heavily used in the replicator
      return null;
    }

    const data = await memcache.get(getHash(normalizedKey));
    if (data) {
      return JSON.parse(data.value).value;
    }

    const found = await KeyValueCache.findOne({
      key: normalizedKey,
    });
    const notExpired = found?.expiresAt > new Date() || !found?.expiresAt;
    if (found && notExpired) {
      // expiresAt is a Date object, need seconds
      const options = found.expiresAt
        ? { lifetime: Math.floor((found.expiresAt - new Date()) / 1000) }
        : {};
      await memcache.set(getHash(normalizedKey), found.value, options);
      return JSON.parse(found.value).value;
    }
    await memcache.set(`${getHash(normalizedKey)}_null`, "1");
    return null;
  }

  // Only used in emergencies e.g. farquest bot referral logic
  async _getAfterExpiredDate({ key, params, afterDate }) {
    const normalizedKey = this.normalize({ key, params });

    const data = await memcache.get(getHash(normalizedKey));
    if (data) {
      return JSON.parse(data.value).value;
    }

    const found = await KeyValueCache.findOne({
      key: normalizedKey,
    });
    const notExpired = found?.expiresAt > afterDate || !found?.expiresAt;
    if (found && notExpired) {
      await memcache.set(
        getHash(normalizedKey),
        found.value,
        found.expiresAt
          ? {
              lifetime: Math.floor((found.expiresAt - new Date()) / 1000),
            }
          : {}
      );
      return JSON.parse(found.value).value;
    }
    return null;
  }

  /**
   * Get value from cache if it exists and is not expired.
   * Else, set the value in the cache with callback fn and return the value.
   */
  async getOrCallbackAndSet(callback, { key, params, expiresAt }) {
    try {
      const exist = await this.get({ key, params });
      if (exist) {
        return exist;
      }
    } catch (e) {
      // continue
      console.error(e);
    }
    const newValue = await callback?.();
    if (newValue) {
      this.set({ key, params, value: newValue, expiresAt }); // no need to await
    }
    return newValue;
  }

  /**
   * Find one record in the KeyValueCache based on key, params, and additional options.
   * @param {Object} options - The query options including key, params, and any additional query parameters.
   * @returns {Promise<Object|null>} The found record or null if not found.
   */
  async find(options) {
    const { key, params, sort, limit, ...extraOptions } = options;
    const normalizedKey = this.normalize({ key, params });
    try {
      const data = await memcache.get(getHash(JSON.stringify(options)));
      if (data) {
        return JSON.parse(data.value);
      }
      let query = KeyValueCache.find({
        key: normalizedKey,
        ...extraOptions,
      });
      if (sort) {
        query = query.sort(sort);
      }
      if (limit) {
        query = query.limit(limit);
      }
      const found = await query;

      if (found) {
        const foundValue = found.map((f) => JSON.parse(f.value).value);
        await memcache.set(
          getHash(JSON.stringify(options)),
          JSON.stringify(foundValue),
          { lifetime: 60 * 5 } // 5 minute cache
        );
        return foundValue;
      }
    } catch (e) {
      console.error(`Error finding record with key: ${normalizedKey}`, e);
    }
    return null;
  }
}

module.exports = { Service: CacheService };
