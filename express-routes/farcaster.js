const app = require("express").Router();
const Sentry = require("@sentry/node");
const { ethers } = require("ethers");

const rateLimit = require("express-rate-limit");
const { Service: _CacheService } = require("../services/cache/CacheService");
const {
  Service: _FarcasterHubService,
} = require("../services/identities/FarcasterHubService");
const {
  Service: _AccountRecovererService,
} = require("../services/AccountRecovererService");
const { Account } = require("../models/Account");
const axios = require("axios").default;
const {
  Service: _MarketplaceService,
} = require("../services/MarketplaceService");
const {
  getFarcasterUserByFid,
  getFarcasterUserByUsername,
  getFarcasterUserByCustodyAddress,
  getFarcasterUserByConnectedAddress,
  getFarcasterCastByHash,
  getFarcasterCastsInThread,
  getFarcasterCasts,
  getFarcasterFollowing,
  getFarcasterFollowers,
  getFarcasterCastReactions,
  getFarcasterCastLikes,
  getFarcasterCastRecasters,
  getFarcasterCastByShortHash,
  getFarcasterFeed,
  getFidByCustodyAddress,
  getFarcasterUnseenNotificationsCount,
  getFarcasterNotifications,
  getFarcasterUserAndLinksByFid,
  getFarcasterUserAndLinksByUsername,
  postMessage,
  searchFarcasterUserByMatch,
  getFarcasterStorageByFid,
  getFidMetadataSignature,
  getFrame,
  createReport,
  getFrames,
  getSyncedChannelById,
  getSyncedChannelByUrl,
  searchChannels,
  searchFarcasterCasts,
  getActions,
  createAction,
  getFarPay,
  updateFarPay,
  getFarcasterFidByCustodyAddress,
  getFarpayDeeplink,
  getFarcasterUserByAnyAddress,
  getFarcasterL1UserByAnyAddress,
} = require("../helpers/farcaster");
const { fetchAssetMetadata, fetchPriceHistory } = require("../helpers/wallet");
const {
  getInsecureHubRpcClient,
  getSSLHubRpcClient,
} = require("@farcaster/hub-nodejs");
const { requireAuth } = require("../helpers/auth-middleware");
const { memcache, getHash } = require("../connectmemcache");
const {
  getAddressPasses,
  getAddressInventory,
  getListingDetails,
} = require("../helpers/farcaster-utils");
const { getLimit } = require("./apikey");

const lightLimiter = rateLimit({
  windowMs: 1_000,
  max: getLimit(5.0),
  message:
    "Too many requests or invalid API key! See docs.wield.xyz for more info.",
  validate: { limit: false },
});

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 5_000,
  max: getLimit(5.0),
  message:
    "Too many requests or invalid API key! See docs.wield.xyz for more info.",
  validate: { limit: false },
});
const heavyLimiter = rateLimit({
  windowMs: 5_000,
  max: getLimit(1.0),
  message:
    "Too many requests or invalid API key! See docs.wield.xyz for more info.",
  validate: { limit: false },
});

let _hubClient;
const getHubClient = () => {
  if (!_hubClient) {
    _hubClient =
      process.env.HUB_SECURE === "SECURE"
        ? getSSLHubRpcClient(process.env.HUB_ADDRESS)
        : getInsecureHubRpcClient(process.env.HUB_ADDRESS);
  }
  return _hubClient;
};

// Warning: this authContext is shared with get-current-account (who needs FID), so make sure you test both!
// Also shared by agents.js
const authContext = async (req, res, next) => {
  const hubClient = getHubClient();

  try {
    if (req.context && req.context.accountId && req.context.hubClient) {
      return next();
    }
    const FCHubService = new _FarcasterHubService();

    const data = await requireAuth(req.headers.authorization || "");

    if (!data.payload.id) {
      throw new Error("jwt must be provided");
    }
    const account = await Account.findByIdCached(data.payload.id);
    if (!account) {
      throw new Error(`Account id ${data.payload.id} not found`);
    }
    if (account.deleted) {
      throw new Error(`Account id ${data.payload.id} deleted`);
    }

    const externalOverride = req.headers.external === "true"; // When an accessToken is shared between FID/.cast, we support overriding with the external header
    const fid = (
      (!externalOverride && data.payload.signerId) || // signerId is the FID for onchain users
      (await FCHubService.getFidByAccountId(
        data.payload.id,
        data.payload.isExternal,
        externalOverride
      ))
    )
      ?.toString()
      .toLowerCase();

    const CacheService = new _CacheService();
    // We only want to send notifications to authenticated users (for performance)
    const enableNotificationsExists = await CacheService.get({
      key: `enableNotifications_${fid}`,
    });
    if (!enableNotificationsExists || Math.random() < 0.01) {
      // 1% chance to write to cache even if it exists, to reduce writing to db
      CacheService.set({
        key: `enableNotifications_${fid}`,
        value: "1",
        expiresAt: new Date(Date.now() + 1000 * 60 * 90 * 24 * 60), // 60 day expiry
      }); // don't block the request on writing to cache
    }
    req.context = {
      ...(req.context || {}),
      accountId: data.payload.id,
      fid,
      account,
      hubClient,
    };
  } catch (e) {
    if (
      !e.message.includes("jwt must be provided") &&
      !e.message.includes("jwt malformed")
    ) {
      Sentry.captureException(e);
      console.error(e);
    }
    req.context = {
      ...(req.context || {}),
      accountId: null,
      fid: null,
      account: null,
      hubClient,
      signerId: null,
    };
  }
  next();
};

app.get("/v2/feed", [limiter, authContext], async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || 20);
    const cursor = req.query.cursor || null;
    const explore = req.query.explore === "true";

    let [casts, next] = await getFarcasterFeed({
      limit,
      cursor,
      context: req.context,
      explore,
    });

    return res.json({
      result: { casts },
      next,
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/cast", [limiter, authContext], async (req, res) => {
  try {
    let hash = req.query.hash;
    if (!hash) {
      return res.status(400).json({
        error: "Missing hash",
      });
    }

    const cast = await getFarcasterCastByHash(hash, req.context);

    return res.json({
      result: { cast },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/cast-short", [limiter, authContext], async (req, res) => {
  try {
    let shortHash = req.query.shortHash;
    let username = req.query.username;
    if (!shortHash || !username) {
      return res.status(400).json({
        error: "Missing hash or username",
      });
    }

    const cast = await getFarcasterCastByShortHash(
      shortHash,
      username,
      req.context
    );

    return res.json({
      result: { cast },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/casts-in-thread", [limiter, authContext], async (req, res) => {
  try {
    const threadHash = req.query.threadHash;
    const parentHash = req.query.parentHash;
    const limit = Math.min(req.query.limit || 10, 50);
    const cursor = req.query.cursor || null;
    if (!threadHash) {
      return res.status(400).json({
        error: "Missing threadHash",
      });
    }

    const [casts, next] = await getFarcasterCastsInThread({
      threadHash,
      limit,
      cursor,
      parentHash,
      context: req.context,
    });

    return res.json({
      result: { casts },
      next,
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/casts", [limiter, authContext], async (req, res) => {
  try {
    const fid = req.query.fid;
    const filters = JSON.parse(req.query.filters || null);
    const parentChain = req.query.parentChain || null;
    const limit = Math.min(req.query.limit || 10, 100);
    const cursor = req.query.cursor || null;
    const explore = req.query.explore === "true";

    let [casts, next] = await getFarcasterCasts({
      fid,
      parentChain,
      limit,
      cursor,
      context: req.context,
      explore,
      filters,
    });

    return res.json({
      result: { casts },
      next,
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/search-casts", [heavyLimiter, authContext], async (req, res) => {
  return res.status(503).json({
    error: "This endpoint is unavailable.",
  });
  try {
    const query = req.query.query;
    const limit = Math.min(req.query.limit || 10, 100);
    const cursor = req.query.cursor || null;

    let [casts, next] = await searchFarcasterCasts({
      query,
      limit,
      cursor,
      context: req.context,
    });

    return res.json({
      result: { casts },
      next,
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/cast-reactions", limiter, async (req, res) => {
  try {
    const castHash = req.query.castHash;
    const limit = Math.min(parseInt(req.query.limit || 100), 250);
    const cursor = req.query.cursor || null;

    if (!castHash) {
      return res.status(400).json({
        error: "castHash is invalid",
      });
    }

    const [reactions, next] = await getFarcasterCastReactions(
      castHash,
      limit,
      cursor
    );

    return res.json({
      result: {
        reactions,
        next,
      },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/cast-likes", limiter, async (req, res) => {
  try {
    const castHash = req.query.castHash;
    const limit = Math.min(parseInt(req.query.limit || 100), 250);
    const cursor = req.query.cursor || null;

    if (!castHash) {
      return res.status(400).json({
        error: "castHash is invalid",
      });
    }

    const [likes, next] = await getFarcasterCastLikes(castHash, limit, cursor);

    return res.json({
      result: { likes, next },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/cast-recasters", limiter, async (req, res) => {
  try {
    const castHash = req.query.castHash;
    const limit = Math.min(parseInt(req.query.limit || 100), 250);
    const cursor = req.query.cursor || null;

    if (!castHash) {
      return res.status(400).json({
        error: "castHash is invalid",
      });
    }

    const [users, next] = await getFarcasterCastRecasters(
      castHash,
      limit,
      cursor
    );

    return res.json({
      result: { users, next },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/followers", limiter, async (req, res) => {
  try {
    const fid = req.query.fid;
    const limit = Math.min(parseInt(req.query.limit || 100), 250);
    const cursor = req.query.cursor || null;

    if (!fid) {
      return res.status(400).json({
        error: "fid is invalid",
      });
    }

    const [users, next] = await getFarcasterFollowers(fid, limit, cursor);

    return res.json({
      result: { users, next },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/following", limiter, async (req, res) => {
  try {
    const fid = req.query.fid;
    const limit = Math.min(parseInt(req.query.limit || 100), 250);
    const cursor = req.query.cursor || null;

    if (!fid) {
      return res.status(400).json({
        error: "fid is invalid",
      });
    }

    const [users, next] = await getFarcasterFollowing(fid, limit, cursor);

    return res.json({
      result: { users, next },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

// get user by address. Address can be a custody adress in case of FID, or a L2 address
app.get("/v2/user-by-address", [limiter], async (req, res) => {
  try {
    const address = (req.query.address || "").toLowerCase();
    const onlyUseL1 = req.query.external === "false";

    if (!address || address.length < 10) {
      return res.status(400).json({
        error: "address is invalid",
      });
    }

    const user = onlyUseL1
      ? await getFarcasterL1UserByAnyAddress(address)
      : await getFarcasterUserByAnyAddress(address);

    return res.json({
      result: { user },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/user-by-custody-address", [limiter], async (req, res) => {
  try {
    const address = (req.query.address || "").toLowerCase();

    if (!address || address.length < 10) {
      return res.status(400).json({
        error: "address is invalid",
      });
    }

    const user = await getFarcasterUserByCustodyAddress(address);

    return res.json({
      result: { user },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/user-by-connected-address", [limiter], async (req, res) => {
  try {
    const address = req.query.address || "";

    if (!address || address.length < 10) {
      return res.status(400).json({
        error: "address is invalid",
      });
    }

    const user = await getFarcasterUserByConnectedAddress(address);

    return res.json({
      result: { user },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/user", [limiter, authContext], async (req, res) => {
  try {
    const fid = req.query.fid;

    if (!fid) {
      return res.status(400).json({
        error: "fid is invalid",
      });
    }

    const user = await getFarcasterUserAndLinksByFid({
      fid,
      context: req.context,
    });

    return res.json({
      result: { user },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/users", [limiter, authContext], async (req, res) => {
  try {
    const fids = req.query.fids;

    const fidsParsed = fids && fids.split(",");

    if (!fids || !fidsParsed) {
      return res.status(400).json({
        error: "fids is invalid",
      });
    }

    if (fidsParsed.length > 100) {
      return res.status(400).json({
        error: "fids is invalid",
      });
    }

    const users = await Promise.all(
      fidsParsed.map((fid) =>
        getFarcasterUserAndLinksByFid({
          fid,
          context: req.context,
        })
      )
    );

    return res.json({
      result: { users },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/user-by-username", [limiter, authContext], async (req, res) => {
  try {
    const username = req.query.username;

    if (!username) {
      return res.status(400).json({
        error: "username is invalid",
      });
    }

    const user = await getFarcasterUserAndLinksByUsername({
      username,
      context: req.context,
    });

    return res.json({
      result: { user },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/farquester", [limiter], async (req, res) => {
  try {
    const CacheService = new _CacheService();
    const imageUrl = await CacheService.get({
      key: `FARQUEST_CHARACTER`,
      params: {
        address: req.query.address,
      },
    });

    return res.json({
      result: imageUrl ? { imageUrl } : {},
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.post("/v2/farquester", [limiter], async (req, res) => {
  try {
    const CacheService = new _CacheService();
    const imageUrl = req.body.imageUrl;

    if (!imageUrl || !req.body.address) {
      return res.status(400).json({
        error: "Bad Request - imageUrl is required",
      });
    }

    await CacheService.set({
      key: `FARQUEST_CHARACTER`,
      params: {
        address: req.body.address,
      },
      value: imageUrl,
      expiresAt: null, // or set an expiration time if necessary
    });

    return res.json({
      result: { success: true },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get(
  "/v2/unseen-notifications-count",
  [limiter, authContext],
  async (req, res) => {
    try {
      if (!req.context.accountId) {
        return res.status(401).json({
          error: "Unauthorized",
        });
      }

      const CacheService = new _CacheService();
      let lastSeen = await CacheService.get({
        key: `UNSEEN_NOTIFICATIONS_COUNT`,
        params: {
          accountId: req.context.accountId,
        },
      });
      if (!lastSeen) {
        lastSeen = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      }
      const unseenCount = await getFarcasterUnseenNotificationsCount({
        lastSeen,
        context: req.context,
      });

      return res.json({
        result: { unseenCount },
        source: "v2",
      });
    } catch (e) {
      Sentry.captureException(e);
      console.error(e);
      return res.status(500).json({
        error: "Internal Server Error",
      });
    }
  }
);

app.post("/v2/notifications/seen", [limiter, authContext], async (req, res) => {
  try {
    if (!req.context.accountId) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const CacheService = new _CacheService();
    await CacheService.set({
      key: `UNSEEN_NOTIFICATIONS_COUNT`, // last seen
      params: {
        accountId: req.context.accountId,
      },
      value: new Date(),
      expiresAt: null,
    });

    await memcache.delete(
      `getFarcasterUnseenNotificationsCount:${req.context.fid}`,
      { noreply: true }
    );

    return res.json({
      result: { success: true },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/notifications", [limiter, authContext], async (req, res) => {
  try {
    if (!req.context.accountId) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }
    const limit = parseInt(req.query.limit || 100);
    const cursor = req.query.cursor || null;
    let [notifications, next] = await getFarcasterNotifications({
      limit,
      cursor,
      context: req.context,
    });
    return res.json({
      result: { notifications: notifications, next: next },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.post("/v2/message", [heavyLimiter, authContext], async (req, res) => {
  if (!req.context.accountId) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }
  const externalFid = req.context.fid;

  try {
    const result = await postMessage({
      isExternal: req.body.isExternal || externalFid.startsWith("0x") || false,
      externalFid,
      messageJSON: req.body.message,
      hubClient: req.context.hubClient,
      errorHandler: (error) => {
        Sentry.captureException(error);
        console.error(error);
      },
      bodyOverrides: req.body.bodyOverrides,
    });
    res.json(result);
  } catch (error) {
    Sentry.captureException(error);
    console.error(error);
    let e = "Internal Server Error";
    if (error?.message?.includes("no storage")) {
      e = "No active storage for this FID, buy a storage unit at far.quest!";
    } else if (error?.message?.includes("invalid signer")) {
      e =
        "Invalid signer! If this error persists, try logging out and logging in again.";
    }
    res.status(500).json({ error: e });
  }
});

app.get("/v2/signed-key-requests", limiter, async (req, res) => {
  try {
    const key = "0x" + req.query.key;
    const SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN = {
      name: "Farcaster SignedKeyRequestValidator",
      version: "1",
      chainId: 10,
      verifyingContract: "0x00000000fc700472606ed4fa22623acf62c60553",
    };

    const SIGNED_KEY_REQUEST_TYPE = [
      { name: "requestFid", type: "uint256" },
      { name: "key", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ];
    const deadline = Math.floor(Date.now() / 1000) + 86400; // signature is valid for 1 day
    if (!process.env.FARCAST_KEY) {
      console.error("FARCAST_KEY not configured");
      return res.status(500).json({
        error: "Not configured",
      });
    }
    const wallet = ethers.Wallet.fromMnemonic(process.env.FARCAST_KEY);
    const signature = await wallet._signTypedData(
      SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN,
      { SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE },
      {
        requestFid: ethers.BigNumber.from(18548),
        key,
        deadline: ethers.BigNumber.from(deadline),
      }
    );

    const { data } = await axios.post(
      `https://api.warpcast.com/v2/signed-key-requests`,
      {
        requestFid: "18548",
        deadline: deadline,
        key,
        signature,
      }
    );

    return res.json({ result: data.result, source: "v2" });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/search-user-by-match", heavyLimiter, async (req, res) => {
  try {
    const match = req.query.match;
    const limit = Math.min(parseInt(req.query.limit || 10), 50);

    if (!match) {
      return res.status(400).json({
        error: "match is invalid",
      });
    }

    const users = await searchFarcasterUserByMatch(match, limit);

    return res.json({
      result: { users },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Do not require authContext as we use this for checking holders for non-authenticated users!
app.get("/v2/get-address-passes", limiter, async (req, res) => {
  try {
    const address = (req.query.address || "").toLowerCase();

    if (!address || address.length < 10) {
      return res.status(400).json({
        error: "address is invalid",
      });
    }

    const { isHolder, passes } = await getAddressPasses(
      address,
      req.query.checkHolderOnly
    );

    if (req.query.checkHolderOnly) {
      return res.json({
        result: { isHolder },
        source: "v2",
      });
    }

    return res.json({
      result: { passes, isHolder },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/v2/get-farcaster-storage", limiter, async (req, res) => {
  const data = await getFarcasterStorageByFid(req.query.fid);

  return res.json({ result: { data } });
});

app.post(
  "/v2/marketplace/listings/complete",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const newListing = await MarketplaceService.list(req.body);
      res.json({ result: { listing: newListing }, success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.get("/v2/marketplace/listings", [limiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();

    const limit = Math.min(parseInt(req.query.limit) || 10, 25);

    const [listings, next] = await MarketplaceService.getListings({
      ...req.query,
      limit,
      filters: JSON.parse(req.query.filters || "{}"),
    });
    return res.json({ listings: listings, next });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/marketplace/stats", [limiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const { stats, success } = await MarketplaceService.getStats();
    return res.json({ stats, success });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/marketplace/listing", [limiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const listing = await MarketplaceService.getListing(req.query);
    return res.json({ listing });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/marketplace/listing/details", [limiter], async (req, res) => {
  try {
    const { listing, userData, offers, history } = await getListingDetails(
      req.query
    );

    return res.json({ listing, userData, offers, history });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/marketplace/activities", [limiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const [activities, next] = await MarketplaceService.getActivities(
      req.query
    );
    return res.json({ result: { activities, next } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/marketplace/offers", [limiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const offers = await MarketplaceService.getOffers(req.query);
    return res.json({ result: { offers } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/marketplace/offer", [limiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const offer = await MarketplaceService.getOffer(req.query);
    return res.json({ result: { offer } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/marketplace/best-offer", [limiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const offer = await MarketplaceService.getBestOffer(req.query);
    return res.json({ result: { offer } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/marketplace/appraisal", [limiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const appraisal = await MarketplaceService.getAppraisal(req.query);
    return res.json({ result: { appraisal } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post(
  "/v2/marketplace/appraisal/submit",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const appraisal = await MarketplaceService.appraise(req.body);
      res.json({ result: { appraisal }, success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post("/v2/marketplace/listings/buy", [heavyLimiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const newListing = await MarketplaceService.buy(req.body);
    return res.json({ success: true, result: { listing: newListing } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post(
  "/v2/marketplace/listings/cancel",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const newListing = await MarketplaceService.cancelListing(req.body);
      return res.json({ success: true, result: { listing: newListing } });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post(
  "/v2/marketplace/offers/complete",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const newOffer = await MarketplaceService.offer(req.body);
      res.json({ result: { offer: newOffer }, success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post("/v2/marketplace/offers/cancel", [heavyLimiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const newOffer = await MarketplaceService.cancelOffer(req.body);
    res.json({ result: { offer: newOffer }, success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/v2/marketplace/offers/accept", [heavyLimiter], async (req, res) => {
  try {
    const MarketplaceService = new _MarketplaceService();
    const newOffer = await MarketplaceService.approveOffer(req.body);
    res.json({ result: { offer: newOffer }, success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/metadata/signature", [heavyLimiter], async (req, res) => {
  try {
    const { publicKey, deadline } = req.query;
    if (!publicKey || !deadline) {
      return res.status(400).json({
        error: "publicKey and deadline are required",
      });
    }
    const signature = await getFidMetadataSignature({
      publicKey,
      deadline,
    });
    return res.json({ result: { signature } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/signers", [heavyLimiter], async (req, res) => {
  try {
    const { fid, state } = req.query;
    if (!fid) {
      return res.status(400).json({
        error: "fid is required",
      });
    }
    const AccountRecovererService = new _AccountRecovererService();
    const keys = await AccountRecovererService.getSigners(null, {
      fid,
      state,
    });
    return res.json({ result: { keys } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/frames", [limiter], async (req, res) => {
  try {
    const limit = Math.min(req.query.limit || 10, 100);
    const cursor = req.query.cursor || null;

    let [frames, next] = await getFrames({
      limit,
      cursor,
    });

    return res.json({
      result: { frames },
      next,
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/frames/:hash", [limiter], async (req, res) => {
  try {
    const frame = await getFrame(req.params.hash);
    res.json({ result: { frame } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/v2/reports", [heavyLimiter, authContext], async (req, res) => {
  try {
    if (!req.context.accountId) {
      throw new Error("Unauthorized");
    }
    await createReport(req.body.fid, req.context.fid);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/v2/trends", [limiter, authContext], async (req, res) => {
  const CacheService = new _CacheService();
  try {
    const [trendingTokens, topTrendingCasts] = await Promise.all([
      CacheService.get({
        key: "CastTrendingTokens",
      }),
      CacheService.get({
        key: "TopTrendingCasts",
      }),
    ]);
    const parsedTrendingTokens = trendingTokens ? trendingTokens : {};
    const tokenPriceDifferencesPromise = Promise.all(
      Object.entries(parsedTrendingTokens).map(
        async ([token, currentCount]) => {
          const [lastPriceRecords, lastDayPriceRecord] = await Promise.all([
            CacheService.find({
              key: `TrendingHistory`,
              params: { token },
              sort: { createdAt: -1 },
              limit: 2,
            }),
            CacheService.find({
              key: `TrendingHistory`,
              params: { token },
              sort: { createdAt: -1 },
              limit: 1,
              createdAt: { $lte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            }),
          ]);

          const lastPriceRecord = lastDayPriceRecord[0] || lastPriceRecords[1];

          const lastCount =
            lastPriceRecord && lastPriceRecord.count
              ? lastPriceRecord.count
              : currentCount;
          const percentageDifference =
            lastCount === 0
              ? 0
              : ((currentCount - lastCount) / lastCount) * 100;

          return {
            token,
            percentageDifference,
            count: currentCount,
            lastCount,
            lastTimestamp: lastPriceRecord?.computedAt || null,
          };
        }
      )
    );
    const castsPromise = await Promise.all(
      topTrendingCasts?.casts?.map((cast) =>
        getFarcasterCastByHash(cast.hash, req.context)
      )
    );
    const [tokenPriceDifferences, casts] = await Promise.all([
      tokenPriceDifferencesPromise,
      castsPromise,
    ]);
    const validCasts = casts.filter((cast) => cast !== null);

    const tokenDifferencesObject = tokenPriceDifferences.reduce(
      (
        acc,
        { token, percentageDifference, count, lastCount, lastTimestamp }
      ) => {
        acc[token] = {
          percentageDifference,
          count,
          lastCount,
          lastTimestamp,
        };

        return acc;
      },
      {}
    );
    return res.json({
      result: {
        trends: tokenDifferencesObject,
        ...(req.query.onlyTrends ? {} : { casts: validCasts }),
      },
      source: "v2",
    });
  } catch (e) {
    console.error("Failed to retrieve CastTrendingTokens from cache:", e);
    Sentry.captureException(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/trends/:token", [limiter, authContext], async (req, res) => {
  const TRENDY_CAST_COUNT = 25;
  const CacheService = new _CacheService();
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }
    const { castTimerange = "3d", tokenTimerange = "7d" } = req.query;

    let daysAgo;
    if (castTimerange === "1d") {
      daysAgo = 1;
    } else if (castTimerange === "3d") {
      daysAgo = 3;
    } else if (castTimerange === "7d") {
      daysAgo = 7;
    }
    const dynamicDaysAgo = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

    const trendingCastsHistoryPromise = CacheService.find({
      key: `TrendingCastsHistory`,
      params: { token: token.toUpperCase() },
      sort: { createdAt: -1 },
      limit: 1,
    });

    const trendingHistoryPromise = CacheService.find({
      key: `TrendingHistory`,
      params: { token: token.toUpperCase() },
      createdAt: { $gt: dynamicDaysAgo },
      sort: { createdAt: 1 },
    });

    const [trendingCasts, trendingHistory] = await Promise.all([
      trendingCastsHistoryPromise,
      trendingHistoryPromise,
    ]);

    // const highestCountPerDay = trendingHistory.reduce((acc, entry) => {
    //   const entryDate = new Date(entry.computedAt).toISOString().split("T")[0]; // Extract date in 'YYYY-MM-DD' format
    //   if (!acc[entryDate] || entry.count > acc[entryDate].count) {
    //     acc[entryDate] = entry; // Store or replace with entry if it has a higher count
    //   }
    //   return acc;
    // }, {});

    // const filteredTrendingHistory = Object.values(highestCountPerDay);

    const trendHistory = trendingHistory.map((entry) => {
      const currentCount = entry.count;
      const res = {
        computedAt: entry.computedAt,
        currentCount,
        token: entry.token,
        network: entry.network,
        contractAddress: entry.contractAddress,
      };

      return res;
    });

    if (!trendingCasts || !trendingCasts[0]) {
      return res.status(404).json({ error: "No history found for this token" });
    }

    const { casts } = trendingCasts[0];

    if (!casts || casts.length === 0) {
      return res
        .status(404)
        .json({ error: "No casts found in the history for this token" });
    }

    // Parse each of the casts using getFarcasterCastByHash
    const uniqueCasts = [
      ...new Set(casts?.slice(0, TRENDY_CAST_COUNT).map((cast) => cast.hash)),
    ];
    const castsDetails = await Promise.all(
      uniqueCasts.map((hash) => getFarcasterCastByHash(hash, req.context))
    );

    // Filter out any null responses (in case some casts were not found)
    const validCasts = castsDetails.filter((cast) => cast !== null);

    if (validCasts.length === 0) {
      return res.status(404).json({ error: "Casts not found" });
    }
    let tokenMetadata = null;
    let tokenPriceHistory = [];
    const lastTrendHistory = trendHistory[trendHistory.length - 1];

    if (lastTrendHistory?.contractAddress) {
      const results = await Promise.allSettled([
        fetchAssetMetadata(
          lastTrendHistory.network,
          lastTrendHistory.contractAddress
        ),
        fetchPriceHistory(
          lastTrendHistory.contractAddress,
          lastTrendHistory.network,
          tokenTimerange
        ),
      ]);

      tokenMetadata =
        results[0].status === "fulfilled" ? results[0].value : null;
      tokenPriceHistory =
        results[1].status === "fulfilled" ? results[1].value : [];
    }

    return res.json({
      result: {
        casts: validCasts,
        trendHistory,
        tokenMetadata,
        tokenPriceHistory,
      },
      source: "v2",
    });
  } catch (e) {
    console.error("Failed to retrieve trends for token:", e);
    Sentry.captureException(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/synced-channel/:identifier", async (req, res) => {
  try {
    const { identifier, type } = req.params;
    if (!identifier) {
      return res.status(400).json({ error: "Channel identifier is required" });
    }

    let syncedChannel;
    // Determine retrieval method based on type parameter
    if (type === "id") {
      syncedChannel = await getSyncedChannelById(identifier);
    } else if (type === "url") {
      syncedChannel = await getSyncedChannelByUrl(identifier);
    } else {
      // Attempt to retrieve the channel by ID or URL if type is not specified
      syncedChannel =
        (await getSyncedChannelById(identifier)) ||
        (await getSyncedChannelByUrl(identifier));
    }

    if (!syncedChannel) {
      return res.status(404).json({ error: "Synced channel not found" });
    }

    return res.json({ syncedChannel });
  } catch (e) {
    console.error("Failed to retrieve synced channel:", e);
    Sentry.captureException(e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/v2/search-channel", async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const channels = await searchChannels(query);

    return res.json({ channels });
  } catch (e) {
    console.error("Failed to search channels:", e);
    Sentry.captureException(e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/v2/actions", [limiter], async (req, res) => {
  try {
    const limit = Math.min(req.query.limit || 10, 100);
    const cursor = req.query.cursor || null;

    let [actions, next] = await getActions({
      limit,
      cursor,
    });

    return res.json({
      result: { actions },
      next,
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.post("/v2/actions", [heavyLimiter], async (req, res) => {
  try {
    let action = await createAction(req.body);

    return res.json({
      result: { action },
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.post("/v2/actions/fetch-action", [heavyLimiter], async (req, res) => {
  const { proxyUrl, untrustedData, trustedData } = req.body;
  try {
    let response = await axios.post(
      proxyUrl,
      {
        trustedData,
        untrustedData,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    return res.json({
      result: response.data,
      type: response.data.type || "message",
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);

    return res.status(500).json({
      error: e.message || e.response?.data?.message || "Internal Server Error",
    });
  }
});

// GET route for get fid stats
app.get("/v2/get-fid-stats", [limiter], async (req, res) => {
  try {
    const fid = req.query.fid;
    if (!fid) {
      throw new Error("Fid not found");
    }

    const promises = [
      getFarcasterFidByCustodyAddress(fid),
      getFarcasterUserByFid(fid),
      getFarcasterStorageByFid(fid),
    ];
    const [farcasterByCustodyFid, farcasterByFid, storage] = await Promise.all(
      promises
    );

    let signerExist = false;
    if (req.query.signer) {
      const recovererService = new _AccountRecovererService();

      signerExist = await recovererService.verifyFarcasterSignerAndGetFid(
        null,
        {
          signerAddress: req.query.signer,
          fid: farcasterByCustodyFid || farcasterByFid?.fid, // check if one of these has a signer
        }
      );
    }

    res.status(201).json({
      code: "201",
      success: true,
      message: "Success",
      stats: {
        hasFid: farcasterByCustodyFid || !farcasterByFid?.external, // if has a farcaster custody, then it has a fid
        storage,
        validSigner: !!signerExist,
      },
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    res.status(500).json({
      code: "500",
      success: false,
      message: e.message,
    });
  }
});

app.get("/v2/farpay/:uniqueId", [lightLimiter], async (req, res) => {
  try {
    const { uniqueId } = req.params;
    const farPay = await getFarPay(uniqueId);
    return res.json({ farPay });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.post("/v2/farpay", [heavyLimiter], async (req, res) => {
  try {
    const farPay = await updateFarPay(req.body);
    return res.json({ farPay });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.post("/v2/farpay/deeplink", [lightLimiter], async (req, res) => {
  try {
    const { txId, data, callbackUrl } = req.body;

    const { deepLinkUrl, uniqueId } = await getFarpayDeeplink({
      txId,
      data,
      callbackUrl,
    });
    return res.json({ deepLinkUrl, uniqueId });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.post(
  "/v2/marketplace/listings/nft/complete",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const newListing = await MarketplaceService.listTokenId(req.body);
      res.json({ result: { listing: newListing }, success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post(
  "/v2/marketplace/listings/nft/buy",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const newListing = await MarketplaceService.buyTokenId(req.body);
      res.json({ result: { listing: newListing }, success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post(
  "/v2/marketplace/listings/nft/cancel",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const newListing = await MarketplaceService.cancelListTokenId(req.body);
      res.json({ result: { listing: newListing }, success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post(
  "/v2/marketplace/offers/nft/complete",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const newOffer = await MarketplaceService.offerTokenId(req.body);
      res.json({ result: { offer: newOffer }, success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post(
  "/v2/marketplace/offers/nft/cancel",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const newOffer = await MarketplaceService.cancelOfferTokenId(req.body);
      res.json({ result: { offer: newOffer }, success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.post(
  "/v2/marketplace/offers/nft/accept",
  [heavyLimiter],
  async (req, res) => {
    try {
      const MarketplaceService = new _MarketplaceService();
      const newOffer = await MarketplaceService.approveOfferTokenId(req.body);
      res.json({ result: { offer: newOffer }, success: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  }
);

app.get("/v2/inventory", [limiter], async (req, res) => {
  try {
    const {
      address,
      limit = 100,
      cursor = null,
      filters = {},
      sort,
    } = req.query;

    if (!address || address.length < 10) {
      return res.status(400).json({
        error: "address is invalid",
      });
    }

    // Parse the limit as an integer
    const parsedLimit = parseInt(limit) || 100;

    // Parse the filters if it's a string
    const parsedFilters =
      typeof filters === "string" ? JSON.parse(filters) : filters;

    const [inventory, nextCursor] = await getAddressInventory({
      address,
      limit: parsedLimit,
      cursor,
      filters: parsedFilters,
      sort,
    });

    return res.json({
      result: { inventory },
      nextCursor,
      source: "v2",
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.get("/v2/marketplace/listings/history", [limiter], async (req, res) => {
  try {
    const { fid, tokenId, chainId, timerange } = req.query;

    if (!fid && !tokenId) {
      return res.status(400).json({
        error: "Either fid or tokenId is required",
      });
    }

    const marketplaceService = new _MarketplaceService();
    const historicalSales = await marketplaceService.getHistoricalSales({
      fid: fid ? fid : undefined,
      tokenId: tokenId ? tokenId : undefined,
      chainId: chainId ? parseInt(chainId) : undefined,
      timerange: timerange || "30d",
    });

    return res.json({
      result: historicalSales,
      success: true,
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.status(500).json({
      error: "Internal Server Error",
      success: false,
    });
  }
});

app.get("/v3/trends", [limiter, authContext], async (req, res) => {
  const CacheService = new _CacheService();
  try {
    const [trendingTokens] = await Promise.all([
      CacheService.get({
        key: "CastTrendingTokensV2",
      }),
    ]);

    const parsedTrendingTokens = trendingTokens ? trendingTokens : {};
    const tokenHistoryPromise = Promise.all(
      Object.entries(parsedTrendingTokens).map(
        async ([token, currentCount]) => {
          const [hourHistory, dayHistory, weekHistory] = await Promise.all([
            CacheService.find({
              key: `TrendingHistory`,
              params: { token },
              sort: { createdAt: -1 },
              limit: 1,
              createdAt: { $lte: new Date(Date.now() - 60 * 60 * 1000 * 1.5) }, // have a buffer
            }),
            CacheService.find({
              key: `TrendingHistory`,
              params: { token },
              sort: { createdAt: -1 },
              limit: 1,
              createdAt: { $lte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            }),
            CacheService.find({
              key: `TrendingHistory`,
              params: { token },
              sort: { createdAt: -1 },
              limit: 1,
              createdAt: {
                $lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
              },
            }),
          ]);

          const hourCount = hourHistory[0]?.count || 0;
          const dayCount = dayHistory[0]?.count || 0;
          const weekCount = weekHistory[0]?.count || 0;

          const difference = {
            "1h": currentCount.count - hourCount,
            "1d": currentCount.count - dayCount,
            "1w": currentCount.count - weekCount,
          };

          const percentageDifference = {
            "1h": hourCount === 0 ? 100 : (difference["1h"] / hourCount) * 100,
            "1d": dayCount === 0 ? 100 : (difference["1d"] / dayCount) * 100,
            "1w": weekCount === 0 ? 100 : (difference["1w"] / weekCount) * 100,
          };

          return {
            token,
            difference,
            percentageDifference,
            count: currentCount.count,
            metrics: currentCount,
            lastTimestamp: dayHistory[0]?.computedAt || null,
          };
        }
      )
    );

    const tokenHistoryResults = await tokenHistoryPromise;
    const tokenHistoryObject = tokenHistoryResults.reduce(
      (
        acc,
        {
          token,
          difference,
          percentageDifference,
          count,
          lastTimestamp,
          metrics,
        }
      ) => {
        acc[token] = {
          percentageDifference,
          count,
          difference,
          lastTimestamp,
          metrics,
        };

        return acc;
      },
      {}
    );

    return res.json({
      result: {
        trends: tokenHistoryObject,
      },
      source: "v3",
    });
  } catch (e) {
    console.error("Failed to retrieve trending data:", e);
    Sentry.captureException(e);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

module.exports = {
  router: app,
  farcasterAuthContext: authContext,
};
