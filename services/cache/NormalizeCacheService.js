class NormalizeCacheService {
  /** hook to verify before normalize
   * Key is the type of cache key. There are special types which require params.
   */
  _beforeNormalize({ key, params }) {
    if (!key) throw new Error("Invalid key");
    let normalizedKey;
    let normalizedParams;
    switch (key) {
      // cache for a list of communities with read permissions for an account
      case "ExploreFeedCommunities": {
        if (!params.accountId)
          throw new Error("Missing required param accountId");
        normalizedKey = `ExploreFeedCommunities:Account:${params.accountId}`;
        break;
      }
      default: {
        normalizedParams = params;
        normalizedKey = key;
      }
    }
    return { key: normalizedKey, params: normalizedParams };
  }

  normalize({ key, params }) {
    const { key: normalizedKey, params: normalizedParams } =
      this._beforeNormalize({ key, params });

    return `${normalizedKey}${
      normalizedParams ? `:${JSON.stringify(normalizedParams)}` : ""
    }`;
  }
}

module.exports = { Service: NormalizeCacheService };
