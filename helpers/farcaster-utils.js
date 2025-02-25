const {
  NobleEd25519Signer,
  Message,
  makeReactionAdd: makeReactionAddRpc,
  makeReactionRemove: makeReactionRemoveRpc,
  makeCastAdd: makeCastAddRpc,
  makeCastRemove: makeCastRemoveRpc,
  makeLinkAdd: makeLinkAddRpc,
  makeLinkRemove: makeLinkRemoveRpc,
  makeUserDataAdd: makeUserDataAddRpc,
  makeFrameAction: makeFrameActionRpc,
  getInsecureHubRpcClient,
  getSSLHubRpcClient,
  toFarcasterTime,
  MessageType,
  UserDataType,
  ReactionType,
} = require("@farcaster/hub-nodejs");
const { memcache } = require("../connectmemcache");
const {
  Service: _MarketplaceService,
} = require("../services/MarketplaceService");
const { CastHandle } = require("../models/CastHandle");
const {
  postMessage,
  getConnectedAddressForFid,
  getCustodyAddressByFid,
} = require("./farcaster");
const axios = require("axios");

const Sentry = require("@sentry/node");
const { ethers } = require("ethers");
const { validateAndConvertAddress } = require("./validate-and-convert-address");

const DEFAULT_NETWORK = 1;

const USERNAME_PROOF_DOMAIN = {
  name: "Farcaster name verification",
  version: "1",
  chainId: 1,
  verifyingContract: "0xe3be01d99baa8db9905b33a3ca391238234b79d1",
};

const USERNAME_PROOF_TYPE = {
  UserNameProof: [
    { name: "name", type: "string" },
    { name: "timestamp", type: "uint256" },
    { name: "owner", type: "address" },
  ],
};

async function getAddressPasses(address, checkHolderOnly) {
  if (!address || address.length < 10) {
    throw new Error("address is invalid");
  }

  let isHolder = null;
  let passes = [];

  try {
    const cacheKey = `getAddressPasses:${address}`;
    const cacheIsHolderKey = `getAddressPasses_isHolder:${address}`;
    const dataFromCache = await memcache.get(cacheKey);
    const isHolderDataFromCache = await memcache.get(cacheIsHolderKey);

    if (dataFromCache) {
      passes = JSON.parse(dataFromCache.value);
      isHolder = true; // Assuming presence in cache implies holder
    } else if (isHolderDataFromCache) {
      isHolder = JSON.parse(isHolderDataFromCache.value);
    } else {
      // Check isHolder state
      isHolder = await CastHandle.exists({ owner: address.toLowerCase() });

      // Cache isHolder state
      await memcache.set(cacheIsHolderKey, JSON.stringify(isHolder), {
        lifetime: isHolder ? 60 * 60 * 1 : 1, // 1 hour cache if holder, 1s cache if not
      });
    }

    if (checkHolderOnly) {
      return { isHolder, passes };
    }

    if (isHolder && !dataFromCache) {
      // Fetch and process NFTs if not retrieved from cache
      passes = await getCastHandles(address);

      // Cache the result if passes are found
      if (passes?.length > 0) {
        // We assume isHolder is true if passes are found
        await memcache.set(cacheKey, JSON.stringify(passes), { lifetime: 10 }); // 10 second cache
      }
    }
  } catch (error) {
    console.error(error);
    throw new Error("Failed to retrieve address passes");
  }

  return { passes, isHolder };
}

async function getCastHandles(address) {
  const handles = await CastHandle.find({ owner: address.toLowerCase() });
  return handles
    .filter((handle) => handle?.handle) // We do not filter out 0x - due to missing metadata
    .map((handle) =>
      handle.chain === "ETH"
        ? `${handle.handle.toLowerCase()}.cast`
        : handle.chain === "OP"
        ? `${handle.handle.replace("op_", "").toLowerCase()}.op.cast`
        : `${handle.handle.replace("base_", "").toLowerCase()}.base.cast`
    );
}

async function getCastHandlesWithMetadata({
  address,
  limit = 100,
  filters,
  sort = "-fid",
  cursor,
}) {
  const MarketplaceService = new _MarketplaceService();

  if (filters && Object.keys(filters).length > 0) {
    return await MarketplaceService.getListings({
      sort,
      limit,
      cursor,
      filters: {
        ...filters,
        collection: "castHandle",
        address: validateAndConvertAddress(address),
      },
    });
  }

  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  let handles;
  if (cursor) {
    const cacheKey = `getCastHandlesWithMetadata:${address}:${limit}:${cursor}`;
    const cachedData = await memcache.get(cacheKey);
    if (cachedData) {
      handles = JSON.parse(cachedData.value).map(
        (handle) => new CastHandle(handle)
      );
    }
  }

  if (!handles) {
    handles = await CastHandle.find({
      owner: address.toLowerCase(),
      id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
    })
      .sort({ _id: -1 })
      .limit(limit);

    if (cursor) {
      const cacheKey = `getCastHandlesWithMetadata:${address}:${limit}:${cursor}`;
      await memcache.set(cacheKey, JSON.stringify(handles), { lifetime: 10 }); // Cache for 10 seconds
    }
  }

  const filteredHandles = handles.filter((handle) => handle?.handle);

  const handlesWithListing = await Promise.all(
    filteredHandles.map(async (handle) => {
      const chainId = handle.chain === "ETH" ? 1 : 10;
      const [listing] = await Promise.all([
        MarketplaceService.getListing({
          fid: -1,
          tokenId: ethers.BigNumber.from(handle.tokenId).toString(),
          chainId: chainId,
        }),
      ]);
      return { ...handle.toObject(), listing };
    })
  );

  let nextCursor = null;
  if (handles.length === limit) {
    nextCursor = `${handles[handles.length - 1]._id}-${
      handles[handles.length - 1]._id
    }`;
  }

  return [handlesWithListing, nextCursor];
}

async function getListingDetails({ fid, tokenId, chainId }) {
  const MarketplaceService = new _MarketplaceService();

  tokenId = tokenId ? tokenId.toString() : undefined;
  chainId = chainId ? parseInt(chainId) : undefined;
  const [userData, listing, offers, history] = await Promise.all([
    MarketplaceService.fetchUserData(fid, tokenId, chainId),
    MarketplaceService.fetchListing(fid, tokenId, chainId),
    MarketplaceService.getOffers({ fid, tokenId, chainId }),
    MarketplaceService.getHistoricalSales({ fid, tokenId, chainId }),
  ]);

  return {
    userData,
    listing,
    offers,
    history,
  };
}

// middleware to parse a frame context
const frameContext = async (req, res, next) => {
  if (req.context && req.context.frameData) {
    return next();
  }
  if (!req.body?.trustedData && !req.body?.untrustedData) {
    return next();
  }
  if (!req.body.trustedData) {
    req.context = {
      ...(req.context || {}),
      frameData: req.body.untrustedData,
      untrustedData: req.body.untrustedData,
      verifiedFrameData: false,
      isExternal: true,
      connectedAddress: req.body?.untrustedData?.fid,
    };
    return next();
  }
  try {
    const messageData = Message.decode(
      Buffer.from(req.body.trustedData.messageBytes, "hex")
    );
    let newContext = {
      ...(req.context || {}),
      frameData: messageData.data,
      untrustedData: req.body.untrustedData,
      verifiedFrameData: true,
    };
    if (!ethers.utils.isAddress(req.body.untrustedData?.fid)) {
      if (!messageData.data?.fid) {
        throw new Error(
          "FID is missing, no fallback external FID: " +
            JSON.stringify(messageData.data)
        );
      }
      // non external
      const connectedAddress = await getConnectedAddressForFid(
        messageData.data.fid
      );
      newContext.isExternal = false;
      newContext.connectedAddress = connectedAddress;
      if (
        req.body.untrustedData?.isCustodyWallet ||
        !connectedAddress ||
        !ethers.utils.isAddress(connectedAddress)
      ) {
        const custodyAddress = await getCustodyAddressByFid(
          messageData.data.fid
        );
        newContext.connectedAddress = custodyAddress;
      }
    } else {
      newContext.isExternal = true;
      newContext.connectedAddress = req.body?.untrustedData?.fid;
    }
    req.context = newContext;
  } catch (e) {
    console.error(e);
    if (!e?.message?.includes("FID is missing, no fallback external FID")) {
      Sentry.captureException(e, {
        extra: {
          body: req.body,
          context: req.context,
        },
      });
    }
    req.context = {
      ...(req.context || {}),
      frameData: req.body.untrustedData,
      untrustedData: req.body.untrustedData,
      verifiedFrameData: false,
      isExternal: true,
      connectedAddress: req.body?.untrustedData?.fid,
    };
  } finally {
    next();
  }
};

function hexToBytes(hex) {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function extractAndReplaceMentions(
  input,
  usersMap = {} // key: username, value: fid
) {
  let result = "";
  const mentions = [];
  const mentionsPositions = [];

  // Split on newlines and spaces, preserving delimiters
  const splits = input.split(/(\s|\n)/);

  splits.forEach((split, i) => {
    if (split.startsWith("@")) {
      const mentionRegex = /(?<!\]\()@([a-zA-Z0-9_\-]+(\.[a-z]{2,})*)/g;
      const match = mentionRegex.exec(split);
      const username = match?.[1];

      // Check if user is in the usersMap
      if (username && username in usersMap) {
        // Get the starting position of each username mention
        const position = Buffer.from(result).length;

        mentions.push(usersMap[username]);
        mentionsPositions.push(position);
        result += split.replace("@" + username, "");

        // result += '@[...]'; // replace username mention with what you would like
      } else {
        result += split;
      }
    } else {
      result += split;
    }
  });

  // Return object with replaced text and user mentions array
  return {
    text: result,
    mentions,
    mentionsPositions,
  };
}

const makeMessage = async ({
  privateKey,
  messageType,
  body = {},
  fid,
  overrides = {},
}) => {
  if (!privateKey) {
    throw new Error("No private key provided");
  }
  const signer = new NobleEd25519Signer(Buffer.from(privateKey, "hex"));
  let rawMessage;
  try {
    switch (messageType) {
      case MessageType.CAST_ADD:
        rawMessage = await makeCastAddRpc(
          body,
          {
            fid: parseInt(fid),
            network: DEFAULT_NETWORK,
          },
          signer
        );
        break;
      case MessageType.CAST_REMOVE:
        const milliseconds364DaysAgo = Date.now() - 364 * 24 * 60 * 60 * 1000; // PRUNE_TIME_LIMIT_DEFAULT is 1 year
        const timestamp = toFarcasterTime(milliseconds364DaysAgo).value;
        rawMessage = await makeCastRemoveRpc(
          body,
          {
            fid: parseInt(fid),
            network: DEFAULT_NETWORK,
            timestamp, // In order for casts to be reclaimed from oldest to newest, we want deleted casts gone first. This is only used by @farquest bot for now
          },
          signer
        );
        break;
      case MessageType.REACTION_ADD:
        rawMessage = await makeReactionAddRpc(
          body,
          {
            fid: parseInt(fid),
            network: DEFAULT_NETWORK,
          },
          signer
        );
        break;
      case MessageType.REACTION_REMOVE:
        rawMessage = await makeReactionRemoveRpc(
          body,
          {
            fid: parseInt(fid),
            network: DEFAULT_NETWORK,
          },
          signer
        );
        break;
      case MessageType.LINK_ADD:
        rawMessage = await makeLinkAddRpc(
          body,
          {
            fid: parseInt(fid),
            network: DEFAULT_NETWORK,
          },
          signer
        );
        break;
      case MessageType.LINK_REMOVE:
        rawMessage = await makeLinkRemoveRpc(
          body,
          {
            fid: parseInt(fid),
            network: DEFAULT_NETWORK,
          },
          signer
        );
        break;
      case MessageType.USER_DATA_ADD:
        rawMessage = await makeUserDataAddRpc(
          body,
          {
            fid: parseInt(fid),
            network: DEFAULT_NETWORK,
          },
          signer
        );
        break;
      case MessageType.FRAME_ACTION:
        rawMessage = await makeFrameActionRpc(
          body,
          {
            fid: parseInt(fid),
            network: DEFAULT_NETWORK,
          },
          signer
        );
        break;
      default:
        throw new Error(`Unknown message type: ${messageType}`);
    }
  } catch (e) {
    console.error(e);
    throw new Error("Unable to create message: " + e.message);
  }

  if (!rawMessage) {
    throw new Error("Invalid Farcaster data");
  }

  if (!rawMessage.value) {
    throw rawMessage.error || new Error("Invalid Farcaster data");
  }

  let message = rawMessage.value;
  message = Message.toJSON({
    ...message,
    data: {
      ...message.data,
      ...overrides,
    },
  });

  return message;
};

const makeRequest = async (
  privateKey,
  messageType,
  body,
  fid,
  overrides = {},
  bodyOverrides = {},
  options = {}
) => {
  const DEFAULT_URI_BASE =
    process.env.NODE_ENV === "production"
      ? "https://build.far.quest"
      : "http://localhost:8080";

  const message = await makeMessage({
    privateKey,
    messageType,
    body,
    fid,
    overrides,
  });
  let isExternal = fid?.slice(0, 2) === "0x" ? true : false;

  if (!isExternal) {
    // it can also be external if any of the keys or subkeys of bodyOverrides contains 0x
    isExternal = Object.keys(bodyOverrides).some((key) => {
      if (typeof bodyOverrides[key] === "object") {
        return Object.keys(bodyOverrides[key]).some((subkey) => {
          return bodyOverrides[key][subkey]?.slice(0, 2) === "0x";
        });
      }
      return bodyOverrides[key]?.slice?.(0, 2) === "0x";
    });
  }
  const token = options.accessToken;
  if (!token) {
    const hubClient =
      process.env.HUB_SECURE === "SECURE"
        ? getSSLHubRpcClient(process.env.HUB_ADDRESS)
        : getInsecureHubRpcClient(process.env.HUB_ADDRESS);
    const result = await postMessage({
      isExternal: isExternal || fid.startsWith("0x") || false,
      externalFid: fid,
      messageJSON: message,
      hubClient,
      errorHandler:
        options?.errorHandler ||
        ((error) => {
          Sentry.captureException(error);
          console.error(error);
        }),
      bodyOverrides,
    });

    return result;
  }
  const response = await axios.post(
    `${DEFAULT_URI_BASE}/farcaster/v2/message`,
    {
      isExternal,
      message,
      bodyOverrides,
    },
    {
      headers: {
        "Content-Type": "application/json",
        authorization: token ? `Bearer ${token}` : "",
        "API-KEY": "far.quest-default-5477272",
      },
    }
  );

  return response.data;
};

const makeCastAdd = async ({
  privateKey,
  text,
  mentionsFids = [],
  mentionsUsernames = [],
  embeds,
  parentHash,
  parentFid,
  parentUrl,
  fid,
  accessToken,
}) => {
  const data = extractAndReplaceMentions(
    text,
    mentionsUsernames.reduce((acc, username, i) => {
      acc[username] = mentionsFids[i];
      return acc;
    }, {})
  );

  const body = {
    ...data,
    embeds: embeds || [],
  };
  const bodyOverrides = {};

  if (parentHash) {
    body.parentCastId = {
      hash: hexToBytes(parentHash.slice(2)),
      fid: parseInt(parentFid),
    };
    bodyOverrides.parentCastId = { fid: parentFid };
  }
  if (parentUrl) {
    body.parentUrl = parentUrl;
  }
  bodyOverrides.mentions = body.mentions;
  body.mentions = body.mentions.map((a) => parseInt(a));
  body.type = Buffer.from(data.text, "utf-8").length > 320 ? 1 : 0; // // 320 for CAST, 321 to 1024 for LONG_CAST enum CastType { CAST = 0; LONG_CAST = 1; }

  const options = {};
  if (accessToken) {
    options.accessToken = accessToken;
  }
  try {
    return await makeRequest(
      privateKey,
      MessageType.CAST_ADD,
      body,
      fid,
      {},
      bodyOverrides,
      options
    );
  } catch (e) {
    console.error(e);
    throw new Error(e);
  }
};

const makeCastRemove = async (
  { privateKey, targetHash, fid },
  options = {}
) => {
  const body = {
    targetHash: hexToBytes(targetHash.slice(2)),
  };

  return await makeRequest(
    privateKey,
    MessageType.CAST_REMOVE,
    body,
    fid,
    {},
    {},
    options
  );
};

const makeLinkAdd = async ({
  privateKey,
  type,
  displayTimestamp,
  targetFid,
  fid,
}) => {
  const body = {
    type: type,
    displayTimestamp: displayTimestamp,
    targetFid: parseInt(targetFid),
  };
  const bodyOverrides = {
    targetFid: targetFid,
  };

  return await makeRequest(
    privateKey,
    MessageType.LINK_ADD,
    body,
    fid,
    {},
    bodyOverrides
  );
};

const makeUsernameDataAdd = async ({ privateKey, value: username, fid }) => {
  const body = {
    type: UserDataType.USERNAME,
    value: username,
  };

  return await makeRequest(privateKey, MessageType.USER_DATA_ADD, body, fid, {
    userDataBody: {
      value: username,
      type: UserDataType.USERNAME,
    },
  });
};

const makeUserDataAdd = async ({ privateKey, type, value, fid }) => {
  if (type === UserDataType.USERNAME) {
    // username
    return await makeUsernameDataAdd({ privateKey, value, fid });
  }
  const body = {
    type: type,
    value: value,
  };

  try {
    return await makeRequest(privateKey, MessageType.USER_DATA_ADD, body, fid);
  } catch (e) {
    throw new Error(e);
  }
};

const makeLinkRemove = async ({ privateKey, type, targetFid, fid }) => {
  const body = {
    type: type,
    targetFid: parseInt(targetFid),
  };
  const bodyOverrides = {
    targetFid: targetFid,
  };

  return await makeRequest(
    privateKey,
    MessageType.LINK_REMOVE,
    body,
    fid,
    {},
    bodyOverrides
  );
};

const makeReactionAdd = async ({
  privateKey,
  type,
  castHash,
  castAuthorFid,
  targetUrl = "", // this is the channel url
  fid,
  accessToken,
}) => {
  const body = {
    type: type,
    targetCastId: {
      hash: hexToBytes(castHash.slice(2)),
      fid: parseInt(castAuthorFid),
    },
    // targetUrl: targetUrl,
  };
  const bodyOverrides = {
    targetCastId: {
      fid: castAuthorFid,
    },
  };
  const options = {};
  if (accessToken) {
    options.accessToken = accessToken;
  }

  return await makeRequest(
    privateKey,
    3,
    body,
    fid,
    {},
    bodyOverrides,
    options
  ); // MESSAGE_TYPE_REACTION_ADD = 3
};

const makeReactionRemove = async ({
  privateKey,
  type,
  castHash,
  castAuthorFid,
  targetUrl = "", // this is the channel url
  fid,
}) => {
  const body = {
    type: type,
    targetCastId: {
      hash: hexToBytes(castHash.slice(2)),
      fid: parseInt(castAuthorFid),
    },
    // targetUrl: targetUrl,
  };
  const bodyOverrides = {
    targetCastId: {
      fid: castAuthorFid,
    },
  };

  return await makeRequest(
    privateKey,
    MessageType.REACTION_REMOVE,
    body,
    fid,
    {},
    bodyOverrides
  );
};

const follow = async (props) => {
  return await makeLinkAdd({
    type: "follow",
    ...props,
  });
};

const unfollow = async (props) => {
  return await makeLinkRemove({
    type: "follow",
    ...props,
  });
};

const like = async ({ isRemove, ...props }) => {
  if (isRemove) {
    return await makeReactionRemove({
      type: ReactionType.LIKE,
      ...props,
    });
  }
  return await makeReactionAdd({
    type: ReactionType.LIKE,
    ...props,
  });
};

const recast = async ({ isRemove, ...props }) => {
  if (isRemove) {
    return await makeReactionRemove({
      type: ReactionType.RECAST,
      ...props,
    });
  }
  return await makeReactionAdd({
    type: ReactionType.RECAST,
    ...props,
  });
};

async function getAddressInventory({
  address,
  limit = 100,
  cursor = null,
  filters,
  sort,
}) {
  try {
    const [result, nextCursor] = await getCastHandlesWithMetadata({
      address,
      limit,
      cursor,
      filters,
      sort,
    });

    return [result, nextCursor];
  } catch (error) {
    console.error("Error in getAddressInventory:", error);
    throw new Error("Failed to retrieve address inventory");
  }
}

async function registerUsername(
  { fname, fid, owner, privateKey },
  providedWallet
) {
  const timestamp = Math.floor(Date.now() / 1000);

  // Create and sign the proof
  const wallet = providedWallet || new ethers.Wallet(privateKey);
  const signature = await wallet._signTypedData(
    USERNAME_PROOF_DOMAIN,
    USERNAME_PROOF_TYPE,
    {
      name: fname,
      timestamp: ethers.BigNumber.from(timestamp),
      owner,
    }
  );

  // Register the fname
  const response = await fetch("https://fnames.farcaster.xyz/transfers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: fname,
      from: 0,
      to: parseInt(fid),
      fid: parseInt(fid),
      owner,
      timestamp,
      signature,
    }),
  });

  const result = await response.json();

  if (result.error) {
    throw new Error(
      result.code === "USERNAME_TAKEN"
        ? "Username already taken"
        : result.error || "Failed to register username"
    );
  }

  return true;
}

module.exports = {
  makeCastAdd,
  makeCastRemove,
  makeLinkAdd,
  makeLinkRemove,
  makeReactionAdd,
  makeReactionRemove,
  makeUserDataAdd,
  follow,
  unfollow,
  like,
  recast,
  frameContext,
  getAddressPasses,
  getAddressInventory,
  getListingDetails,
  makeMessage,
  registerUsername,
  USERNAME_PROOF_DOMAIN,
  USERNAME_PROOF_TYPE,
  hexToBytes,
};
