const {
  getFarcasterUserByFid,
  getFarcasterFidByCustodyAddress,
} = require("../../helpers/farcaster");
const { Account } = require("../../models/Account");
const { memcache } = require("../../connectmemcache");

class FarcasterHubService {
  _getSigner(account, isExternal) {
    let existingRecoverer;

    if (isExternal === true) {
      existingRecoverer = account.recoverers?.find?.((r) => {
        return r.type === "FARCASTER_SIGNER_EXTERNAL";
      });
    } else if (isExternal === false) {
      existingRecoverer = account.recoverers?.find?.((r) => {
        return r.type === "FARCASTER_SIGNER";
      });
    } else {
      // just try both
      existingRecoverer = account.recoverers?.find?.((r) => {
        return r.type === "FARCASTER_SIGNER";
      });
      if (!existingRecoverer) {
        existingRecoverer = account.recoverers?.find?.((r) => {
          return r.type === "FARCASTER_SIGNER_EXTERNAL";
        });
      }
    }

    return existingRecoverer || null;
  }
  async getProfileFid(fid) {
    const profile = await getFarcasterUserByFid(fid);
    return profile;
  }

  async getProfileByAccount(account, isExternal) {
    if (!account) return null;
    let existingRecoverer = this._getSigner(account, isExternal);
    if (!existingRecoverer) {
      return null;
    }

    const profile = await getFarcasterUserByFid(existingRecoverer.id);
    return profile;
  }
  // externalOverride = account.address[0].address, same as auth/v1/get-current-account
  // When an accessToken is shared between FID/.cast, we support overriding with the external header
  async getFidByAccountId(accountId, isExternal, externalOverride = false) {
    if (!accountId) return null;
    const cached = await memcache.get(
      `FarcasterHubService:getFidByAccountId:${accountId}:${isExternal}:${externalOverride}`
    );
    if (cached) {
      return cached.value === "" ? null : cached.value;
    }
    let fid;
    const account = await Account.findById(accountId);
    let existingRecoverer;
    if (!externalOverride) {
      existingRecoverer = this._getSigner(account, isExternal);
    }
    if (!existingRecoverer) {
      // external account, fid is address or fid of custody address
      await account.populate("addresses");
      const address = account.addresses[0].address;
      if (isExternal || externalOverride) return address?.toLowerCase?.();
      // return fid of custody addresss
      fid = await getFarcasterFidByCustodyAddress(address?.toLowerCase?.());
    } else {
      fid = existingRecoverer.id;
    }
    await memcache.set(
      `FarcasterHubService:getFidByAccountId:${accountId}:${isExternal}:${externalOverride}`,
      fid || "",
      { lifetime: 60 * 5 } // 5 minute lifetime
    );
    return fid;
  }

  isExternalAccount(account) {
    const existingRecoverer = account.recoverers?.find?.((r) => {
      return r.type === "FARCASTER_SIGNER";
    });
    return !existingRecoverer;
  }
}

module.exports = { Service: FarcasterHubService };
