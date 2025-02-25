const {
  Messages,
  Casts,
  Reactions,
  Signers,
  Verifications,
  UserData,
  Fids,
  Fnames,
  Links,
  UserDataType,
  ReactionType,
  Notifications,
  MessageType,
  Listings,
  Storage,
  Frames,
  Reports,
  SyncedChannels,
  SyncedActions,
  FarPay,
  FrameNotification,
} = require("../models/farcaster");
const { CastHandle } = require("../models/CastHandle");
const { config } = require("./registrar");
const { getHexTokenIdFromLabel } = require("./get-token-id-from-label");
const { ethers } = require("ethers");
const { memcache, getHash } = require("../connectmemcache");
const { Message, fromFarcasterTime } = require("@farcaster/hub-nodejs");
const bs58 = require("bs58");
const axios = require("axios");
const Sentry = require("@sentry/node");
const crypto = require("crypto");

async function isFollowingChannel(fid, key) {
  let cursor = "";
  do {
    const response = await axios.get(
      `https://client.warpcast.com/v2/user-following-channels?fid=${fid}&limit=50&cursor=${cursor}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FARQUEST_FARCASTER_APP_TOKEN}`,
        },
      }
    );

    const channels = response.data.result.channels;
    const foundChannel = channels.find((channel) => channel.key === key);
    if (foundChannel) return true;

    cursor = response.data.next?.cursor;
  } while (cursor);

  return false;
}

function farcasterTimeToDate(time) {
  if (time === undefined) return undefined;
  if (time === null) return null;
  const result = fromFarcasterTime(time);
  if (result.isErr()) throw result.error;
  return new Date(result.value);
}

function bytesToHex(bytes) {
  if (bytes === undefined) return undefined;
  if (bytes === null) return null;
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

const getSyncedChannelById = async (channelId) => {
  if (!channelId) {
    return null;
  }

  const cacheKey = `syncedChannel:${channelId}`;
  // Attempt to retrieve the synced channel from memcache
  const cachedData = await memcache.get(cacheKey);
  if (cachedData) {
    return JSON.parse(cachedData.value);
  }

  // If not in cache, find in database
  const syncedChannel = await SyncedChannels.findOne({
    channelId: channelId,
  });
  if (syncedChannel) {
    // Add to memcache with a 6-hour expiration
    await memcache.set(cacheKey, JSON.stringify(syncedChannel), {
      lifetime: 60 * 60 * 6,
    });
  }
  return syncedChannel;
};

const getSyncedChannelByUrl = async (url) => {
  if (!url) {
    return null;
  }

  const cacheKey = `syncedChannel:${url}`;
  // Attempt to retrieve the synced channel from memcache
  const cachedData = await memcache.get(cacheKey);
  if (cachedData) {
    return JSON.parse(cachedData.value);
  }

  // If not in cache, find in database
  const syncedChannel = await SyncedChannels.findOne({
    url: url,
  });
  if (syncedChannel) {
    // Add to memcache with a 6-hour expiration
    await memcache.set(cacheKey, JSON.stringify(syncedChannel), {
      lifetime: 60 * 60 * 6,
    });
  }
  return syncedChannel;
};

const searchChannels = async (input) => {
  if (!input) {
    return [];
  }

  const cacheKey = getHash(`searchChannels:${input}`);
  // Attempt to retrieve the search results from memcache
  const cachedData = await memcache.get(cacheKey);
  if (cachedData) {
    return JSON.parse(cachedData.value);
  }

  // If not in cache, find in database using regex for partial matching
  const matchedChannels = await SyncedChannels.aggregate([
    {
      $match: {
        channelId: { $regex: new RegExp(`^${escapeRegExp(input)}`, "i") },
      },
    },
    { $addFields: { channelIdLength: { $strLenCP: "$channelId" } } },
    { $sort: { channelIdLength: 1 } },
    { $limit: 10 },
  ]);
  if (matchedChannels.length > 0) {
    // Add to memcache with a 1-hour expiration
    await memcache.set(cacheKey, JSON.stringify(matchedChannels), {
      lifetime: 60 * 60 * 6,
    });
  }
  return matchedChannels;
};

const postMessage = async ({
  isExternal = false, // we override with external below if we are replying to an external cast
  externalFid,
  messageJSON,
  hubClient,
  errorHandler = (error) => console.error(error),
  bodyOverrides,
}) => {
  try {
    let external = isExternal;
    let message = Message.fromJSON(messageJSON);
    if (
      !external &&
      [
        MessageType.MESSAGE_TYPE_CAST_ADD,
        MessageType.MESSAGE_TYPE_CAST_REMOVE,
      ].includes(message.type)
    ) {
      // lets try to derive external if any of the parent casts are external
      if (
        message.data.type == MessageType.MESSAGE_TYPE_CAST_ADD &&
        message.data.castAddBody.parentCastId
      ) {
        const parentCast = await Casts.findOne({
          hash: bytesToHex(message.data.castAddBody.parentCastId.hash),
        });
        external = parentCast?.external || external;
      } else if (message.data.type == MessageType.MESSAGE_TYPE_CAST_REMOVE) {
        const parentCast = await Casts.findOne({
          hash: bytesToHex(message.data.castRemoveBody.targetHash),
        });
        external = parentCast?.external || external;
      }
    }
    if (
      external &&
      message.data.type === MessageType.MESSAGE_TYPE_USER_DATA_ADD &&
      message.data.userDataBody.type === UserDataType.USER_DATA_TYPE_USERNAME
    ) {
      let username = Buffer.from(message.data.userDataBody.value)
        .toString("ascii")
        .replace(".beb", "")
        .replace(".cast", "");
      if (username.includes(".op")) {
        username = "op_" + username.replace(".op", "");
      } else if (username.includes(".base")) {
        username = "base_" + username.replace(".base", "");
      }
      const usernameTokenId = getHexTokenIdFromLabel(username);

      const exists = await CastHandle.exists({
        owner: externalFid?.toLowerCase(),
        tokenId: usernameTokenId.toLowerCase(),
      });
      if (!exists) {
        const invalidPassesError = `Invalid UserData for external user, could not find ${username}/${usernameTokenId} in CastHandles!`;
        if (process.env.NODE_ENV === "production") {
          throw new Error(invalidPassesError);
        } else {
          console.error(invalidPassesError);
        }
      }
    }

    if (!external) {
      const hubResult = await hubClient.submitMessage(message);
      const unwrapped = hubResult.unwrapOr(null);
      if (!unwrapped) {
        throw new Error(`Could not send message: ${hubResult?.error}`);
      } else {
        message = {
          ...unwrapped,
          hash: unwrapped.hash,
          signer: unwrapped.signer,
        };
      }
    }

    const now = new Date();
    let messageData = {
      fid: external ? externalFid : message.data.fid,
      createdAt: now,
      updatedAt: now,
      messageType: message.data.type,
      timestamp: farcasterTimeToDate(message.data.timestamp),
      hash: bytesToHex(message.hash),
      hashScheme: message.hashScheme,
      signature: bytesToHex(message.signature),
      signatureScheme: message.signatureScheme,
      signer: bytesToHex(message.signer),
      raw: bytesToHex(Message.encode(message).finish()),
      external,
      unindexed: true,
      bodyOverrides,
    };

    try {
      await Messages.create(messageData);
    } catch (e) {
      if ((e?.code || 0) === 11000) {
        console.error("Message with this hash already exists, skipping!");
      } else {
        throw e;
      }
    }

    return { result: messageData, source: "v2" };
  } catch (e) {
    errorHandler(e);
    throw e; // Re-throw to let the caller handle it further if needed
  }
};

const GLOBAL_SCORE_THRESHOLD = 50;
const GLOBAL_SCORE_THRESHOLD_CHANNEL = 5;

const getFarcasterUserByFid = async (fid) => {
  const data = await memcache.get(`getFarcasterUserByFid:${fid}`);
  if (data) {
    return JSON.parse(data.value);
  }
  if (!fid) return null;
  const [
    following,
    followers,
    allUserData,
    fname,
    fids,
    connectedAddress,
    allConnectedAddresses,
  ] = await Promise.all([
    getFarcasterFollowingCount(fid),
    getFarcasterFollowersCount(fid),
    UserData.find({ fid, deletedAt: null }).sort({ createdAt: 1 }),
    Fnames.findOne({ fid, deletedAt: null }),
    Fids.findOne({ fid, deletedAt: null }),
    getConnectedAddressForFid(fid),
    getConnectedAddressesForFid(fid),
  ]);
  const external = fid.toString().startsWith("0x") || false;
  if (!fids && !external) {
    return null;
  }

  if (fids?.nerfed) {
    return null;
  }

  let user = {
    fid: fid.toString().toLowerCase(),
    followingCount: following,
    followerCount: followers,
    pfp: {
      url: "",
      verified: false,
    },
    bio: {
      text: "",
      mentions: [],
    },
    external,
    custodyAddress: fids?.custodyAddress,
    connectedAddress,
    allConnectedAddresses,
    username: fname?.fname, // We allow overriding the fname if userdata exists (e.g. ENS username)
  };

  let registeredAt = fids?.timestamp;
  let found = {};

  for (const userData of allUserData) {
    registeredAt = registeredAt || userData.createdAt;
    // determine if userData.createdAt is earlier than registeredAt
    if (userData.createdAt < registeredAt) {
      registeredAt = userData.createdAt;
    }
    const hexString = userData.value.startsWith("0x")
      ? userData.value.slice(2)
      : userData.value;

    const convertedData = Buffer.from(hexString, "hex").toString("utf8");
    switch (userData.type) {
      case UserDataType.USER_DATA_TYPE_USERNAME:
        // Since it can be populated by fname, but we allow overriding with ENS
        if (
          (!user.username || convertedData.includes(".eth")) &&
          !found.username
        ) {
          user.username = convertedData;
          found.username = true;
        }
        break;
      case UserDataType.USER_DATA_TYPE_DISPLAY:
        if (!found.displayName) {
          user.displayName = convertedData;
          found.displayName = true;
        }

        break;
      case UserDataType.USER_DATA_TYPE_PFP:
        if (!found.pfp) {
          user.pfp.url = convertedData;
          found.pfp = true;
        }
        break;
      case UserDataType.USER_DATA_TYPE_BIO:
        if (!found.bio) {
          user.bio.text = convertedData;
          // find "@" mentions not inside a link
          const mentionRegex = /(?<!\]\()@([a-zA-Z0-9_]+(\.[a-z]{2,})*)/g;
          let match;
          while ((match = mentionRegex.exec(convertedData))) {
            user.bio.mentions.push(match[1]);
          }
          found.bio = true;
        }
        break;
      case UserDataType.USER_DATA_TYPE_URL:
        if (!found.url) {
          user.url = convertedData;
          found.url = true;
        }
        break;
    }
  }

  user.registeredAt = registeredAt?.getTime();

  await memcache.set(`getFarcasterUserByFid:${fid}`, JSON.stringify(user));

  return user;
};

const getFarcasterUserAndLinksByFid = async ({ fid, context }) => {
  const user = await getFarcasterUserByFid(fid);
  if (!context.fid || fid === context.fid) return user;
  if (!user) return null;

  let links;

  const data = await memcache.get(
    `getFarcasterUserAndLinksByFid_${context.fid}:${fid}`
  );
  if (data) {
    links = JSON.parse(data.value);
  }

  if (!links) {
    const [isFollowing, isFollowedBy] = await Promise.all([
      Links.exists({
        fid: context.fid,
        targetFid: fid,
        type: "follow",
        deletedAt: null,
      }),
      Links.exists({
        fid,
        targetFid: context.fid,
        type: "follow",
        deletedAt: null,
      }),
    ]);
    links = {
      isFollowing,
      isFollowedBy,
    };
    await memcache.set(
      `getFarcasterUserAndLinksByFid_${context.fid}:${fid}`,
      JSON.stringify(links)
    );
  }
  return {
    ...user,
    ...links,
  };
};

const getFarcasterUserByCustodyAddress = async (custodyAddress) => {
  if (!custodyAddress) return null;
  const fid = await Fids.findOne({ custodyAddress, deletedAt: null });
  if (!fid) return null;

  return await getFarcasterUserByFid(fid.fid);
};
const getFarcasterFidByCustodyAddress = async (custodyAddress) => {
  if (!custodyAddress) return null;

  const data = await memcache.get(
    `getFarcasterFidByCustodyAddress:${custodyAddress}`
  );
  if (data) {
    return data.value === "" ? null : data.value;
  }
  const fid =
    (await Fids.findOne({ custodyAddress, deletedAt: null }))?.fid || null;
  await memcache.set(
    `getFarcasterFidByCustodyAddress:${custodyAddress}`,
    fid || ""
  );
  return fid;
};

const getFarcasterL1UserByAnyAddress = async (address) => {
  const [farcasterByAddress, farcasterByConnectedAddress] = await Promise.all([
    getFarcasterUserByCustodyAddress(address),
    getFarcasterUserByConnectedAddress(address),
  ]);
  const user = farcasterByConnectedAddress || farcasterByAddress;
  return user;
};

const getFarcasterUserByAddress = async (address) => {
  const [farcasterByAddress, farcasterByFid] = await Promise.all([
    getFarcasterUserByCustodyAddress(address),
    getFarcasterUserByFid(address),
  ]);
  const user = farcasterByAddress || farcasterByFid;
  return user;
};

const getFarcasterUserByAnyAddress = async (address) => {
  if (!address) return null;
  const [farcasterByAddress, farcasterByConnectedAddress, farcasterByFid] =
    await Promise.all([
      getFarcasterUserByCustodyAddress(address),
      getFarcasterUserByConnectedAddress(address),
      getFarcasterUserByFid(address),
    ]);

  const user =
    farcasterByConnectedAddress || farcasterByAddress || farcasterByFid;
  return user;
};

const getFarcasterUserByConnectedAddress = async (connectedAddress) => {
  let fid = null;
  const data = await memcache.get(
    `getFarcasterUserByConnectedAddress_fid:${connectedAddress}`
  );
  if (data) {
    fid = data.value;
  }

  if (!fid) {
    const ethereum = connectedAddress.slice(0, 2) === "0x";
    let finalAddress = connectedAddress.toLowerCase();
    if (!ethereum) {
      // assume it is solana, convert base58 to hex
      try {
        finalAddress =
          "0x" + Buffer.from(bs58.decode(connectedAddress)).toString("hex");
      } catch (e) {
        console.error("Error decoding solana address, fallback to hex", e);
      }
    }

    const verification = await Verifications.findOne({
      "claimObj.address": finalAddress,
      deletedAt: null,
    });

    if (verification) {
      fid = verification.fid;
    } else {
      fid = "0";
    }
  }

  await memcache.set(
    `getFarcasterUserByConnectedAddress_fid:${connectedAddress}`,
    fid
  );
  if (fid !== "0") {
    return await getFarcasterUserByFid(fid);
  }

  return null;
};

const getConnectedAddressForFid = async (fid) => {
  if (!fid) return null;

  const data = await memcache.get(`getConnectedAddressForFid:${fid}`);
  if (data) {
    return data.value;
  }
  const verification = await Verifications.findOne({
    fid,
    deletedAt: null,
    $or: [
      { "claimObj.protocol": { $exists: false } },
      { "claimObj.protocol": 0 }, // Ethereum
    ],
  }).sort({ timestamp: -1 });

  if (!verification) return null;

  const claim = verification.claimObj || JSON.parse(verification.claim);
  if (!claim) return null;

  await memcache.set(
    `getConnectedAddressForFid:${fid}`,
    claim.address.toLowerCase()
  );

  return claim.address;
};

const getConnectedAddressesForFid = async (fid) => {
  if (!fid) return { ethereum: [], solana: [] };

  const data = await memcache.get(`getConnectedAddressesForFid:${fid}`);
  if (data) {
    return JSON.parse(data.value);
  }
  const verifications = await Verifications.find({
    fid,
    deletedAt: null,
  });

  const addressesRaw = verifications.map((verification) => {
    const claim = verification.claimObj || JSON.parse(verification.claim);
    switch (claim.protocol) {
      case 1: // Solana
        // base58 decode from hex string
        try {
          return [
            "solana",
            bs58.encode(Buffer.from(claim.address.slice(2), "hex")).toString(),
          ];
        } catch (e) {
          console.error("Error encoding solana address, fallback to hex", e);
          return ["solana", claim.address.toLowerCase()];
        }
      case 0: // Ethereum
      default:
        if (ethers.utils.isAddress(claim.address)) {
          return ["ethereum", claim.address.toLowerCase()];
        } else {
          return null;
        }
    }
  });

  // convert addresses to map
  const addresses = { ethereum: new Set(), solana: new Set() };
  addressesRaw.forEach((address) => {
    if (address) {
      addresses[address[0]].add(address[1]);
    }
  });
  // convert addresses to array
  Object.keys(addresses).forEach((key) => {
    addresses[key] = Array.from(addresses[key]);
  });

  await memcache.set(
    `getConnectedAddressesForFid:${fid}`,
    JSON.stringify(addresses)
  );

  return addresses;
};

const getCustodyAddressByFid = async (fid) => {
  if (!fid) return null;

  const cached = await memcache.get(`getCustodyAddressByFid:${fid}`);
  if (cached) {
    return cached.value;
  }
  const data = await Fids.findOne({ fid, deletedAt: null });
  if (!data) return null;

  await memcache.set(`getCustodyAddressByFid:${fid}`, data.custodyAddress);

  return data.custodyAddress;
};

const getFidByCustodyAddress = async (custodyAddress) => {
  if (!custodyAddress) return null;

  const data = await memcache.get(`getFidByCustodyAddress:${custodyAddress}`);
  if (data) {
    return data.value;
  }
  const fid = await Fids.findOne({ custodyAddress, deletedAt: null });
  if (!fid) return null;

  await memcache.set(`getFidByCustodyAddress:${custodyAddress}`, fid.fid);

  return fid.fid;
};

const searchFarcasterUserByMatch = async (
  username,
  limit = 10,
  sort = "text",
  shouldShowExternal = true
) => {
  if (!username) return [];
  const usernameEscaped = escapeRegExp(username.toLowerCase());

  let cacheKey = `searchFarcasterUserByMatch:${username}`;
  if (!shouldShowExternal) {
    cacheKey += ":noExternal";
  }

  const data = await memcache.get(getHash(cacheKey));
  if (data) {
    return JSON.parse(data.value);
  }

  const [usersByFid, usersByUsername, usersByDisplay] = await Promise.all([
    (async () => {
      const user = await UserData.findOne({
        fid: username,
        deletedAt: null,
        ...(shouldShowExternal ? {} : { external: false }),
      }).read("secondaryPreferred");
      return user ? [user] : [];
    })(),
    process.env.NODE_ENV === "development"
      ? UserData.find({
          text: { $regex: `^${usernameEscaped}` },
          type: UserDataType.USER_DATA_TYPE_USERNAME,
          deletedAt: null,
          ...(shouldShowExternal ? {} : { external: false }),
        })
          .read("secondaryPreferred")
          .limit(limit > 2 ? Math.ceil(limit / 2) : 1)
          .sort(sort)
      : (async () => {
          // In production we use MongoDB Atlas Search Indexes that are powered by Apache Lucene
          // In development, we fallback to regex (really slow)
          try {
            return await UserData.aggregate()
              .search({
                text: {
                  query: username,
                  path: "text",
                  fuzzy: {
                    maxEdits: 2,
                    prefixLength: 0,
                    maxExpansions: 50,
                  },
                  score: {
                    function: {
                      multiply: [
                        {
                          path: {
                            value: "type",
                            undefined: 1,
                          },
                        },
                        {
                          score: "relevance",
                        },
                      ],
                    },
                  },
                },
                index: "search-userdata",
              })
              .limit(limit);
          } catch (e) {
            console.error("Error searching userdata", e);
            Sentry.captureException(e);
            return [];
          }
        })(),
    process.env.NODE_ENV === "development"
      ? UserData.find({
          text: { $regex: `^${usernameEscaped}`, $options: "i" },
          type: UserDataType.USER_DATA_TYPE_DISPLAY,
          deletedAt: null,
          ...(shouldShowExternal ? {} : { external: false }),
        })
          .read("secondaryPreferred")
          .limit(limit > 2 ? Math.ceil(limit / 2) : 1)
          .sort(sort)
      : [],
  ]);

  const users = [...usersByFid, ...usersByUsername, ...usersByDisplay].slice(
    0,
    limit
  );
  const hash = {};

  const fids = users
    .map((user) => {
      if (hash[user.fid]) return null;
      hash[user.fid] = true;
      return user.fid;
    })
    .filter((fid) => fid !== null);

  const farcasterUsers = (
    await Promise.all(fids.map((fid) => getFarcasterUserByFid(fid)))
  )
    .filter(Boolean) // Remove any null/undefined users
    .sort((a, b) => {
      // Sort by followerCount in descending order (higher counts first)
      const followersA = a.followerCount || 0;
      const followersB = b.followerCount || 0;
      return followersB - followersA;
    });

  await memcache.set(getHash(cacheKey), JSON.stringify(farcasterUsers), {
    lifetime: 60 * 5, // 5m
  });

  return farcasterUsers;
};

const getFarcasterFidByUsername = async (username) => {
  let fid;

  const data = await memcache.get(`getFarcasterFidByUsername:${username}`);
  if (data) {
    fid = data.value;
  }
  if (!fid) {
    // Lookup by Fname
    const fname = await Fnames.findOne({
      fname: username,
      deletedAt: null,
    });
    if (fname) {
      if (fname.fid) {
        fid = fname.fid;
      } else {
        fid = await getFidByCustodyAddress(fname.custodyAddress);
      }
    }
  }
  if (!fid) {
    // Fallback to userdata if no fname found (e.g. for .cast handles or missing username proof)
    // convert to hex with 0x prefix
    const hexUsername = "0x" + Buffer.from(username, "ascii").toString("hex");
    const userData = await UserData.findOne({
      value: hexUsername,
      type: UserDataType.USER_DATA_TYPE_USERNAME,
      deletedAt: null,
    }).sort({ createdAt: -1 });
    fid = userData?.fid;
  }
  if (fid) {
    await memcache.set(`getFarcasterFidByUsername:${username}`, fid);
    return fid;
  }
  return null;
};

const getFarcasterUserByUsername = async (username, links = false) => {
  const fid = await getFarcasterFidByUsername(username);
  if (fid) {
    return await getFarcasterUserByFid(fid);
  }
  return null;
};

const getFarcasterUserAndLinksByUsername = async ({ username, context }) => {
  const fid = await getFarcasterFidByUsername(username);
  if (fid) {
    return await getFarcasterUserAndLinksByFid({ fid, context });
  }
  return null;
};

const getFarcasterCastByHash = async (hash, context = {}, options = {}) => {
  let contextData;

  if (context.fid) {
    const [isSelfLike, isSelfRecast] = await Promise.all([
      Reactions.exists({
        targetHash: hash,
        fid: context.fid,
        reactionType: ReactionType.REACTION_TYPE_LIKE,
        deletedAt: null,
      }),
      Reactions.exists({
        targetHash: hash,
        fid: context.fid,
        reactionType: ReactionType.REACTION_TYPE_RECAST,
        deletedAt: null,
      }),
    ]);
    contextData = {
      isSelfLike,
      isSelfRecast,
    };
  }

  const cachedCastData = await memcache.get(`getFarcasterCastByHash:${hash}`);
  if (cachedCastData) {
    const castData = JSON.parse(cachedCastData.value);
    if (castData.author) {
      castData.author = await getFarcasterUserAndLinksByFid({
        fid: castData.author.fid,
        context,
      });
    }

    return { ...castData, ...contextData };
  }

  const cast = await Casts.findOne({ hash });
  if (!cast || cast.deletedAt) return null;

  let replyCast;
  if (options.includeReply) {
    replyCast = await Casts.findOne({
      parentHash: cast.hash,
      deletedAt: null,
    });
    if (replyCast) {
      replyCast = await getFarcasterCastByHash(replyCast.hash, context, false);
    }
  }

  const promises = [
    getFarcasterRepliesCount(cast.hash),
    getFarcasterReactionsCount(cast.hash, ReactionType.REACTION_TYPE_LIKE),
    getFarcasterReactionsCount(cast.hash, ReactionType.REACTION_TYPE_RECAST),
    getFarcasterUserByFid(cast.parentFid),
    getFarcasterUserAndLinksByFid({ fid: cast.fid, context }),
    getSyncedChannelByUrl(cast.parentUrl),
    Promise.all(cast.mentions.map((mention) => getFarcasterUserByFid(mention))),
  ];
  const embeds = JSON.parse(cast.embeds);

  const embedPromises =
    embeds.urls
      ?.filter(
        (url) => url.type === "castId" && !context.quotedCasts?.[url.hash]
      )
      .map((url) =>
        getFarcasterCastByHash(url.hash, {
          ...context,
          quotedCasts: {
            [url.hash]: true, // prevent infinite quote cast loop
          },
        })
      ) || [];

  promises.push(Promise.all(embedPromises));

  const [
    repliesCount,
    reactionsCount,
    recastsCount,
    parentAuthor,
    author,
    channel,
    mentionUsers,
    quoteCasts,
  ] = await Promise.all(promises);

  let text = cast.text || "";
  let offset = 0;
  let updatedMentionsPositions = []; // Array to store updated positions

  // Convert text to a Buffer object to deal with bytes
  let textBuffer = Buffer.from(text, "utf-8");

  for (let i = 0; i < mentionUsers.length; i++) {
    if (!mentionUsers[i]) continue;
    // Assuming mentionsPositions consider newlines as bytes, so no newline adjustment
    const adjustedMentionPosition = cast.mentionsPositions[i];
    const mentionUsername =
      mentionUsers[i].username || "fid:" + mentionUsers[i].fid;

    const mentionLink = `@${mentionUsername}`;
    const mentionLinkBuffer = Buffer.from(mentionLink, "utf-8");

    // Assuming originalMention field exists in mentionUsers array
    const originalMention = mentionUsers[i].originalMention || "";
    const originalMentionBuffer = Buffer.from(originalMention, "utf-8");
    const originalMentionLength = originalMentionBuffer.length;

    // Apply the offset only when slicing the text
    const actualPosition = adjustedMentionPosition + offset;

    const beforeMention = textBuffer.slice(0, actualPosition);
    const afterMention = textBuffer.slice(
      actualPosition + originalMentionLength
    );

    // Concatenating buffers
    textBuffer = Buffer.concat([
      beforeMention,
      mentionLinkBuffer,
      afterMention,
    ]);

    // Update the offset based on the added mention
    offset += mentionLinkBuffer.length - originalMentionLength;

    // Store the adjusted position in the new array
    updatedMentionsPositions.push(actualPosition);
  }

  // Convert the final Buffer back to a string
  text = textBuffer.toString("utf-8");

  const data = {
    hash: cast.hash,
    parentHash: cast.parentHash,
    parentFid: cast.parentFid,
    parentUrl: cast.parentUrl,
    threadHash: cast.threadHash,
    text: text,
    embeds: { ...embeds, quoteCasts },
    mentions: mentionUsers,
    mentionsPositions: updatedMentionsPositions,
    external: cast.external,
    author,
    parentAuthor,
    timestamp: cast.timestamp.getTime(),
    replies: {
      count: repliesCount,
      reply: replyCast,
    },
    reactions: {
      count: reactionsCount,
    },
    recasts: {
      count: recastsCount,
    },
    channel,
    deletedAt: cast.deletedAt,
  };

  await memcache.set(`getFarcasterCastByHash:${hash}`, JSON.stringify(data));

  return { ...data, ...contextData };
};

const getFarcasterFeedCastByHash = async (hash, context = {}) => {
  const cast = await getFarcasterCastByHash(hash, context);
  if (cast?.threadHash === hash) {
    return {
      ...cast,
      childCast: null,
      childrenCasts: [],
    };
  }
  if (cast?.threadHash) {
    // return the root cast with childrenCasts
    const root = await getFarcasterCastByHash(cast.threadHash, context);
    return {
      ...root,
      childCast: cast,
      childrenCasts: [cast],
    };
  }
  return null;
};

const getFarcasterCastByShortHash = async (
  shortHash,
  username,
  context = {}
) => {
  // use username, hash to find cast
  const user = await getFarcasterUserByUsername(username);
  if (!user) return null;

  let castHash;
  const data = await memcache.get(`getFarcasterCastByShortHash:${shortHash}`);
  if (data) {
    castHash = data.value;
  }

  if (!castHash) {
    const cast = await Casts.findOne({
      hash: { $regex: `^${shortHash}` },
      fid: user.fid,
      deletedAt: null,
    });
    if (!cast) return null;
    castHash = cast.hash;
  }

  await memcache.set(`getFarcasterCastByShortHash:${shortHash}`, castHash);

  return await getFarcasterCastByHash(castHash, context);
};

const getFarcasterCastsInThread = async ({
  threadHash,
  parentHash,
  limit,
  cursor,
  context,
}) => {
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];
  let casts;

  const data = await memcache.get(
    `getFarcasterCastsInThread:${threadHash}:${parentHash}:${limit}:${cursor}`
  );
  if (data) {
    casts = JSON.parse(data.value).map((cast) => new Casts(cast));
  }
  const query = {
    threadHash: threadHash,
    deletedAt: null,
    timestamp: { $lt: offset || Date.now() },
    id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
  };
  if (parentHash) {
    query.parentHash = parentHash;
  }

  if (!casts) {
    casts = await Casts.find(query).sort({ timestamp: -1 }).limit(limit);
    if (cursor) {
      await memcache.set(
        `getFarcasterCastsInThread:${threadHash}:${parentHash}:${limit}:${cursor}`,
        JSON.stringify(casts),
        {
          lifetime: 60, // 60s cache
        }
      );
    }
  }

  const children = await Promise.all(
    casts.map(async (c) => {
      const cast = await getFarcasterCastByHash(c.hash, context, {
        includeReply: true,
      });
      if (!cast) return null;
      return {
        ...cast,
        childrenCasts: cast.replies?.reply ? [cast.replies.reply] : [],
      };
    })
  );

  const threadCastData = await getFarcasterCastByHash(threadHash, context);
  let currentHash = parentHash;
  let parentCastsData = [];

  while (currentHash && currentHash !== threadHash) {
    const castData = await getFarcasterCastByHash(currentHash, context);
    if (castData) {
      parentCastsData.push(castData);
      currentHash = castData.parentHash; // Assuming each cast has a 'parentHash' field pointing to its parent
    } else {
      break;
    }
  }

  let next = null;
  if (casts.length === limit) {
    next = `${casts[casts.length - 1].timestamp.getTime()}-${
      casts[casts.length - 1].id
    }`;
  }
  const uniqueCasts = new Map();
  [threadCastData, ...parentCastsData, ...children].forEach((cast) => {
    if (cast && !uniqueCasts.has(cast.hash)) {
      uniqueCasts.set(cast.hash, cast);
    }
  });
  const result = Array.from(uniqueCasts.values());
  return [result, next];
};

const getFarcasterCasts = async ({
  fid,
  parentChain,
  limit,
  cursor,
  context,
  explore = false,
  filters = {},
}) => {
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  const query = {
    timestamp: { $lt: offset || Date.now() },
    id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
    deletedAt: null,
  };

  if (filters?.noReplies) {
    query.parentHash = null;
  } else if (filters?.repliesOnly) {
    query.parentHash = { $ne: null };
  }
  if (fid) {
    query.fid = fid;
  }
  if (parentChain) {
    query.parentUrl = parentChain;
    if (explore) {
      query.globalScore = { $gt: GLOBAL_SCORE_THRESHOLD_CHANNEL };
    }
  }

  let casts;
  if (cursor) {
    const data = await memcache.get(
      `getFarcasterCasts:${fid}:${parentChain}:${limit}:${cursor}:${explore}`
    );
    if (data) {
      casts = JSON.parse(data.value).map((cast) => new Casts(cast));
    }
  }

  if (!casts) {
    casts = await Casts.find(query).sort({ timestamp: -1 }).limit(limit);
    if (cursor) {
      await memcache.set(
        `getFarcasterCasts:${fid}:${parentChain}:${limit}:${cursor}:${explore}`,
        JSON.stringify(casts)
      );
    }
  }

  const castPromises = casts.map((cast) =>
    getFarcasterCastByHash(cast.hash, context)
  );
  const castData = await Promise.all(castPromises);
  // filter out null in castData
  const castDataFinal = castData.filter((cast) => cast);
  const parentHashPromises = castDataFinal.map((cast) => {
    if (cast.parentHash) {
      // return the root cast with childrenCasts
      const root = getFarcasterCastByHash(cast.parentHash, context);
      return root;
    } else {
      return cast;
    }
  });
  const parentData = await Promise.all(parentHashPromises);
  const finalData = castDataFinal.map((cast, index) => {
    if (cast.parentHash && parentData[index]) {
      return {
        ...parentData[index],
        childCast: cast,
        childrenCasts: [cast],
      };
    } else {
      return cast;
    }
  });

  let next = null;
  if (casts.length === limit) {
    next = `${casts[casts.length - 1].timestamp.getTime()}-${
      casts[casts.length - 1].id
    }`;
  }

  return [finalData, next];
};

const searchFarcasterCasts = async ({
  query,
  limit = 10,
  cursor = null,
  context = null,
}) => {
  throw new Error(
    "searchFarcasterCasts is unavailable, index is removed - it wasn't fast."
  );
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  let casts;
  const cacheKey = `searchFarcasterCasts:${query}:${limit}:${cursor}`;
  const cachedData = await memcache.get(cacheKey);
  if (cachedData) {
    casts = JSON.parse(cachedData.value).map((cast) => new Casts(cast));
  }

  if (!casts) {
    const sanitizeSearchQuery = (query) => {
      // Remove unnecessary escapes for $ and -
      return query.replace(/["\\]/g, "\\$&");
    };
    const castQuery = {
      timestamp: { $lt: offset || Date.now() },
      id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
      $text: { $search: sanitizeSearchQuery(query) },
      deletedAt: null,
    };

    casts = await Casts.find(castQuery)
      .read("secondaryPreferred")
      .sort({ _id: -1 })
      .limit(limit)
      .exec();

    await memcache.set(cacheKey, JSON.stringify(casts), {
      expires: 60 * 1,
    }); // Cache for 1 minute
  }

  // map these to getFarcasterCastByHash
  const castPromises = casts.map((cast) =>
    getFarcasterCastByHash(cast.hash, context)
  );
  const castData = await Promise.all(castPromises);

  let next = null;
  if (casts.length === limit) {
    next = `${casts[casts.length - 1].timestamp.getTime()}-${
      casts[casts.length - 1].id
    }`;
  }

  return [castData, next];
};

const getFarcasterFollowingCount = async (fid) => {
  const data = await memcache.get(`getFarcasterFollowingCount:${fid}`);
  if (data) {
    return data.value;
  }
  const count = await Links.countDocuments({
    fid,
    type: "follow",
    deletedAt: null,
  });
  await memcache.set(`getFarcasterFollowingCount:${fid}`, count);
  return count;
};

const getFarcasterFollowing = async (fid, limit, cursor) => {
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  let following;
  if (cursor) {
    const data = await memcache.get(
      `getFarcasterFollowing:${fid}:${limit}:${cursor}`
    ); // When using a cursor cache, we only set the cache if the cursor isn't null
    if (data) {
      following = JSON.parse(data.value).map((follow) => new Links(follow));
    }
  }
  if (!following) {
    following = await Links.find({
      fid,
      type: "follow",
      timestamp: { $lt: offset || Date.now() },
      id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
      deletedAt: null,
    })
      .sort({ timestamp: -1 })
      .limit(limit);
    if (cursor) {
      await memcache.set(
        `getFarcasterFollowing:${fid}:${limit}:${cursor}`,
        JSON.stringify(following)
      );
    }
  }

  const followingPromises = following.map((follow) =>
    getFarcasterUserByFid(follow.targetFid)
  );
  const followingData = (await Promise.all(followingPromises)).filter(
    (user) => !!user
  );

  let next = null;
  if (following.length === limit) {
    next = `${following[following.length - 1].timestamp.getTime()}-${
      following[following.length - 1].id
    }`;
  }

  return [followingData, next];
};

const getFarcasterFollowersCount = async (fid) => {
  const data = await memcache.get(`getFarcasterFollowersCount:${fid}`);
  if (data) {
    return data.value;
  }

  const count = await Links.countDocuments({
    targetFid: fid,
    type: "follow",
    deletedAt: null,
  });
  await memcache.set(`getFarcasterFollowersCount:${fid}`, count);
  return count;
};

const getFarcasterReactionsCount = async (castHash, reactionType) => {
  const data = await memcache.get(
    `getFarcasterReactionsCount:${castHash}:${reactionType}`
  );
  if (data) {
    return data.value;
  }

  const count = await Reactions.countDocuments({
    targetHash: castHash,
    reactionType,
    deletedAt: null,
  });
  await memcache.set(
    `getFarcasterReactionsCount:${castHash}:${reactionType}`,
    count
  );
  return count;
};

const getFarcasterRepliesCount = async (castHash) => {
  if (!castHash) {
    return 0;
  }
  const data = await memcache.get(`getFarcasterRepliesCount:${castHash}`);
  if (data) {
    return data.value;
  }

  const count = await Casts.countDocuments({
    parentHash: castHash,
    deletedAt: null,
  });
  await memcache.set(`getFarcasterRepliesCount:${castHash}`, count);
  return count;
};

const getFarcasterFollowers = async (fid, limit, cursor) => {
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  let followers;
  if (cursor) {
    const data = await memcache.get(
      `getFarcasterFollowers:${fid}:${limit}:${cursor}`
    ); // When using a cursor cache, we only set the cache if the cursor isn't null
    if (data) {
      followers = JSON.parse(data.value).map((follower) => new Links(follower));
    }
  }
  if (!followers) {
    followers = await Links.find({
      targetFid: fid,
      type: "follow",
      timestamp: { $lt: offset || Date.now() },
      id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
      deletedAt: null,
    })
      .sort({ timestamp: -1 })
      .limit(limit);
    if (cursor) {
      await memcache.set(
        `getFarcasterFollowers:${fid}:${limit}:${cursor}`,
        JSON.stringify(followers)
      );
    }
  }

  const followerPromises = followers.map((follow) =>
    getFarcasterUserByFid(follow.fid)
  );
  const followerData = (await Promise.all(followerPromises)).filter(
    (user) => !!user
  );

  let next = null;
  if (followers.length === limit) {
    next = `${followers[followers.length - 1].timestamp.getTime()}-${
      followers[followers.length - 1].id
    }`;
  }

  return [followerData, next];
};

const getFarcasterCastReactions = async (hash, limit, cursor) => {
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];
  let reactions;
  if (cursor) {
    const data = await memcache.get(
      `getFarcasterCastReactions:${hash}:${limit}:${cursor}`
    );
    if (data) {
      reactions = JSON.parse(data.value).map(
        (reaction) => new Reactions(reaction)
      );
    }
  }

  if (!reactions) {
    reactions = await Reactions.find({
      targetHash: hash,
      timestamp: { $lt: offset || Date.now() },
      id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
      deletedAt: null,
    })
      .sort({ timestamp: -1 })
      .limit(limit);
    if (cursor) {
      await memcache.set(
        `getFarcasterCastReactions:${hash}:${limit}:${cursor}`,
        JSON.stringify(reactions)
      );
    }
  }

  const reactionPromises = reactions.map((reaction) =>
    getFarcasterUserByFid(reaction.fid)
  );
  const reactionData = (await Promise.all(reactionPromises)).filter(
    (user) => !!user
  );

  let next = null;
  if (reactions.length === limit) {
    next = `${reactions[reactions.length - 1].timestamp.getTime()}-${
      reactions[reactions.length - 1].id
    }`;
  }

  return [reactionData, next];
};

const getFarcasterCastLikes = async (hash, limit, cursor) => {
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  let likes;
  if (cursor) {
    const data = await memcache.get(
      `getFarcasterCastLikes:${hash}:${limit}:${cursor}`
    );
    if (data) {
      likes = JSON.parse(data.value).map((like) => new Reactions(like));
    }
  }

  if (!likes) {
    likes = await Reactions.find({
      targetHash: hash,
      reactionType: ReactionType.REACTION_TYPE_LIKE,
      id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
      timestamp: { $lt: offset || Date.now() },
      deletedAt: null,
    })
      .sort({ timestamp: -1 })
      .limit(limit);
    if (cursor) {
      await memcache.set(
        `getFarcasterCastLikes:${hash}:${limit}:${cursor}`,
        JSON.stringify(likes)
      );
    }
  }

  const likePromises = likes.map((like) => getFarcasterUserByFid(like.fid));
  const likeData = (await Promise.all(likePromises)).filter((user) => !!user);

  let next = null;
  if (likes.length === limit) {
    next = `${likes[likes.length - 1].timestamp.getTime()}-${
      likes[likes.length - 1].id
    }`;
  }

  return [likeData, next];
};

const getFarcasterCastRecasters = async (hash, limit, cursor) => {
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  let recasts;
  if (cursor) {
    const data = await memcache.get(
      `getFarcasterCastRecasters:${hash}:${limit}:${cursor}`
    );
    if (data) {
      recasts = JSON.parse(data.value).map((recast) => new Reactions(recast));
    }
  }
  if (!recasts) {
    recasts = await Reactions.find({
      targetHash: hash,
      reactionType: ReactionType.REACTION_TYPE_RECAST,
      id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
      timestamp: { $lt: offset || Date.now() },
      deletedAt: null,
    })
      .sort({ timestamp: -1 })
      .limit(limit);
    if (cursor) {
      await memcache.set(
        `getFarcasterCastRecasters:${hash}:${limit}:${cursor}`,
        JSON.stringify(recasts)
      );
    }
  }

  const recastPromises = recasts.map((recast) =>
    getFarcasterUserByFid(recast.fid)
  );
  const recastData = (await Promise.all(recastPromises)).filter(
    (user) => !!user
  );
  let next = null;
  if (recasts.length === limit) {
    next = `${recasts[recasts.length - 1].timestamp.getTime()}-${
      recasts[recasts.length - 1].id
    }`;
  }

  return [recastData, next];
};

const getFarcasterFeed = async ({
  limit = 10,
  cursor = null,
  context = {},
  explore = false,
}) => {
  // cursor is "timestamp"-"id of last cast"
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  // create a basic query for casts
  let query = {
    timestamp: { $lt: offset || Date.now() },
    id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
    deletedAt: null,
  };

  if (explore) {
    query.globalScore = { $gt: GLOBAL_SCORE_THRESHOLD };
  }

  // find casts based on the query
  let casts;
  const data = await memcache.get(
    `getFarcasterFeed:${context?.fid || "global"}:${explore}:${limit}:${cursor}`
  );
  if (data) {
    casts = JSON.parse(data.value).map((cast) => new Casts(cast));
  }

  if (!casts) {
    casts = await Casts.find(query).sort({ timestamp: -1 }).limit(limit);
    if (explore && false) {
      const taggedCasts = await Casts.find({
        tag: "explore",
        timestamp: { $lt: offset || Date.now() },
        id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
        deletedAt: null,
      })
        .sort({ timestamp: -1 })
        .limit(Math.ceil(limit * 0.1));
      taggedCasts.forEach((taggedCast) => {
        const randomPosition = Math.floor(Math.random() * (casts.length - 1));
        casts.splice(randomPosition, 0, taggedCast);
      });
    }
    if (cursor) {
      await memcache.set(
        `getFarcasterFeed:${
          context?.fid || "global"
        }:${explore}:${limit}:${cursor}`,
        JSON.stringify(casts)
      );
    } else {
      await memcache.set(
        `getFarcasterFeed:${
          context?.fid || "global"
        }:${explore}:${limit}:${cursor}`,
        JSON.stringify(casts),
        {
          lifetime: 60, // 60s cache
        }
      );
    }
  }

  const castPromises = casts.map((cast) =>
    getFarcasterFeedCastByHash(cast.hash, context)
  );
  const castData = await Promise.all(castPromises);

  // filter out undefined
  const filteredCastData = castData.filter(
    (cast) => !!cast && (cast.parentHash ? cast.threadHash !== cast.hash : true) // filter out missing threads
  );

  const uniqueFids = {};
  // filter by unique hashes and unique fids
  const uniqueCasts = filteredCastData.reduce((acc, cast) => {
    if (cast.author?.fid) {
      if (!acc[cast.hash] && !uniqueFids[cast.author.fid]) {
        acc[cast.hash] = cast;
        uniqueFids[cast.author.fid] = uniqueFids[cast.author.fid]
          ? uniqueFids[cast.author.fid] + 1
          : 1;
      } else if (!uniqueFids[cast.author.fid]) {
        // If the hash already exists, compare childrenCasts lengths
        if (cast.childrenCasts.length > acc[cast.hash].childrenCasts.length) {
          acc[cast.hash] = cast;
          uniqueFids[cast.author.fid] = uniqueFids[cast.author.fid]
            ? uniqueFids[cast.author.fid] + 1
            : 1;
        }
      }
    }

    return acc;
  }, {});

  let next = null;
  if (casts.length >= limit) {
    next = `${casts[casts.length - 1].timestamp.getTime()}-${
      casts[casts.length - 1].id
    }`;
  }

  return [Object.values(uniqueCasts), next];
};

const getFarcasterUnseenNotificationsCount = async ({ lastSeen, context }) => {
  if (!context.fid) return 0;

  const data = await memcache.get(
    `getFarcasterUnseenNotificationsCount:${context.fid}`
  );
  if (data) {
    return data.value;
  }
  // cursor is "timestamp"-"id of last notification"
  const count = await Notifications.countDocuments({
    toFid: context.fid,
    timestamp: { $gt: lastSeen },
    deletedAt: null,
  });

  await memcache.set(
    `getFarcasterUnseenNotificationsCount:${context.fid}`,
    count
  );

  return count;
};

const getFarcasterNotifications = async ({ limit, cursor, context }) => {
  // cursor is "timestamp"-"id of last notification"
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  let notifications;
  if (cursor) {
    const cached = await memcache.get(
      `getFarcasterNotifications:${context.fid}:${limit}:${cursor}`
    );
    if (cached) {
      notifications = JSON.parse(cached.value).map((n) => new Notifications(n));
    }
  }
  if (!notifications) {
    notifications = await Notifications.find({
      toFid: context.fid,
      timestamp: { $lt: offset || Date.now() },
      fromFid: { $ne: context.fid },
      id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
      deletedAt: null,
    })
      .sort({ timestamp: -1 })
      .limit(limit);

    if (cursor) {
      await memcache.set(
        `getFarcasterNotifications:${context.fid}:${limit}:${cursor}`,
        JSON.stringify(notifications)
      );
    }
  }
  let next = null;
  if (notifications.length === limit) {
    next = `${notifications[notifications.length - 1].timestamp.getTime()}-${
      notifications[notifications.length - 1].id
    }`;
  }

  const data = await Promise.all(
    notifications.map(async (notification) => {
      const [actor, cast] = await Promise.all([
        getFarcasterUserAndLinksByFid({
          fid: notification.fromFid,
          context,
        }),
        ["reply", "mention", "reaction"].includes(notification.notificationType)
          ? getFarcasterCastByHash(notification.payload.castHash, context)
          : null,
      ]);

      let content = {};
      if (cast) {
        content.cast = cast;
      }

      const returnData = {
        type: notification.notificationType,
        timestamp: notification.timestamp.getTime(),
        actor,
        content,
        id: notification.id,
      };
      if (notification.notificationType === "reaction") {
        returnData.reactionType = notification.payload.reactionType;
      }
      return returnData;
    })
  );

  return [data, next];
};

const getFarcasterStorageByFid = async (fid) => {
  let storage;
  const data = await memcache.get(`getFarcasterStorageByFid:${fid}`);
  if (data) {
    storage = JSON.parse(data.value).map((s) => new Storage(s));
  }

  if (!storage) {
    storage = await Storage.find({ fid, deletedAt: null });
    await memcache.set(
      `getFarcasterStorageByFid:${fid}`,
      JSON.stringify(storage)
    );
  }

  // If storage is created before Aug 28, 2024 0:00:00 UTC, add one year to expiry due to storage extension
  // https://github.com/farcasterxyz/protocol/discussions/191
  storage.forEach((s) => {
    if (s.timestamp < new Date("2024-08-28T00:00:00Z")) {
      s.expiry = new Date(s.expiry.getTime() + 1000 * 60 * 60 * 24 * 365);
    }
  });

  return storage.map((s) => {
    return {
      timestamp: s.timestamp,
      fid: s.fid,
      units: s.units,
      expiry: s.expiry,
    };
  });
};

const getFarcasterSignersForFid = async (fid) => {
  let signers;
  const data = await memcache.get(`getFarcasterSignersForFid:${fid}`);
  if (data) {
    signers = JSON.parse(data.value).map((s) => new Signers(s));
  }

  if (!signers) {
    signers = await Signers.find({ fid, deletedAt: null });
    await memcache.set(
      `getFarcasterSignersForFid:${fid}`,
      JSON.stringify(signers)
    );
  }

  return signers.map((s) => s.toJSON());
};

const makeSignatureParams = ({ publicKey, deadline }) => {
  if (!publicKey || !deadline) {
    return {};
  }
  const domainData = {
    name: "Farcaster SignedKeyRequestValidator",
    version: "1",
    chainId: 10,
    verifyingContract: "0x00000000fc700472606ed4fa22623acf62c60553",
  };

  const types = {
    SignedKeyRequest: [
      { name: "requestFid", type: "uint256" },
      { name: "key", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const message = {
    requestFid: ethers.BigNumber.from(config().FARCAST_FID),
    key: `0x${publicKey}`,
    deadline: ethers.BigNumber.from(deadline),
  };

  return {
    primaryType: "SignedKeyRequest",
    domain: domainData,
    types,
    message,
  };
};

const getFidMetadataSignature = async ({ publicKey, deadline }) => {
  const signMessage = async (params) => {
    // Read the mnemonic key from the environment variable
    const mnemonic = config().FARCAST_KEY || config().MOCK_SIGNER_KEY;
    if (!mnemonic) {
      throw new Error("Not configured!");
    }

    // Create a wallet instance
    const wallet = ethers.Wallet.fromMnemonic(mnemonic);

    // Define the EIP-712 data to sign
    const data = {
      domain: params.domain,
      types: params.types,
      message: params.message,
      primaryType: params.primaryType,
    };

    // Sign the EIP-712 structured data
    return await wallet._signTypedData(data.domain, data.types, data.message);
  };

  const params = makeSignatureParams({ publicKey, deadline });
  if (!params.message) {
    throw new Error("Invalid signature params");
  }
  return await signMessage(params);
};

const getFrame = async (hash) => {
  // TODO: If you need this to work use Casts (has frame metadata). farcaster.Frames was 30GB and duplicate data
  const frame = await Frames.findOne({ hash: hash });

  return frame;
};

const getFrames = async ({ limit, cursor }) => {
  // TODO: If you need this to work use Casts (has frame metadata). farcaster.Frames was 30GB and duplicate data
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  const query = {
    createdAt: { $lt: offset || Date.now() },
    id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
  };

  let frames;
  if (cursor) {
    const data = await memcache.get(`getFrames:${limit}:${cursor}`);
    if (data) {
      frames = JSON.parse(data.value).map((frame) => new Frames(frame));
    }
  }

  if (!frames) {
    frames = await Frames.find(query).sort({ createdAt: -1 }).limit(limit);

    if (cursor) {
      await memcache.set(
        `getFrames:${limit}:${cursor}`,
        JSON.stringify(frames)
      );
    }
  }
  let next = null;
  if (frames.length === limit) {
    next = `${frames[frames.length - 1].createdAt.getTime()}-${
      frames[frames.length - 1].id
    }`;
  }

  return [frames, next];
};

const createReport = async (fid, reporter) => {
  if (!fid) {
    return;
  }
  const existingReport = await Reports.findOne({ fid: fid });
  let count = existingReport?.count || 0;
  let reporters = new Set(existingReport?.reporters || []);
  reporters.add(reporter);

  count += 1;

  const report = await Reports.findOneAndUpdate(
    { fid: fid },
    { count, reporters: Array.from(reporters) },
    { upsert: true }
  );

  await memcache.set(`algorithm_getReport:${fid}`, JSON.stringify(report));

  return report;
};

const getActions = async ({ limit, cursor }) => {
  const [offset, lastId] = cursor ? cursor.split("-") : [null, null];

  const query = {
    createdAt: { $lt: offset || Date.now() },
    id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
    deletedAt: null,
    rank: { $gt: -1 },
  };

  let actions;
  if (cursor) {
    const data = await memcache.get(`getActions:${limit}:${cursor}`);
    if (data) {
      actions = JSON.parse(data.value).map((a) => new SyncedActions(a));
    }
  }
  if (!actions) {
    actions = await SyncedActions.find(query).sort("rank _id").limit(limit);
    if (cursor) {
      await memcache.set(
        `getActions:${limit}:${cursor}`,
        JSON.stringify(actions)
      );
    }
  }
  let next = null;
  if (actions.length === limit) {
    next = `${actions[actions.length - 1].createdAt.getTime()}-${
      actions[actions.length - 1].id
    }`;
  }

  return [actions, next];
};

const createAction = async ({ ...payload }) => {
  // Decouple payload from the action creation to match schema fields
  const newAction = {
    name: payload.name,
    icon: payload.icon,
    description: payload.description,
    aboutUrl: payload.aboutUrl,
    actionUrl: payload.actionUrl,
    action: {
      actionType: payload.actionType,
      postUrl: payload.actionPostUrl,
    },
  };

  try {
    const updatedAction = await SyncedActions.findOneAndUpdate(
      { actionUrl: newAction.actionUrl },
      { $set: newAction },
      { upsert: true }
    );
    return updatedAction;
  } catch (error) {
    console.error("Failed to create or update action:", error);
    throw error;
  }
};

const getFarPay = async (uniqueId) => {
  const cacheKey = `farPay:${uniqueId}`;
  let farPay = await memcache.get(cacheKey);

  if (!farPay) {
    farPay = await FarPay.findOne({ uniqueId });
    if (farPay) {
      await memcache.set(cacheKey, JSON.stringify(farPay));
    }
  } else {
    farPay = JSON.parse(farPay.value);
  }

  return farPay;
};

const updateFarPay = async ({ uniqueId, ...payload }) => {
  if (!uniqueId) {
    throw new Error("Missing required uniqueId");
  }
  const updatedFarPay = await FarPay.findOneAndUpdate(
    { uniqueId },
    {
      $set: {
        txHash: payload.txHash,
      },
    },
    { new: true }
  );
  if (!updatedFarPay) {
    throw new Error("FarPay not found");
  }
  await memcache.delete(`farPay:${uniqueId}`);
  return updatedFarPay;
};

const createFarPay = async ({ ...payload }) => {
  if (!payload.txId) {
    throw new Error("Missing required fields");
  }
  const uniqueId = crypto.randomBytes(16).toString("hex");
  const newFarPay = new FarPay({
    uniqueId,
    txId: payload.txId,
    data: JSON.stringify(payload.data),
    callbackUrl: payload.callbackUrl,
  });
  await newFarPay.save();
  return newFarPay;
};

const getFarpayDeeplink = async ({ txId, data, callbackUrl }) => {
  const farPay = await createFarPay({ txId, data, callbackUrl });
  const deepLinkUrl = `farquest://?txId=${txId}&data=${encodeURIComponent(
    JSON.stringify(data)
  )}&uniqueId=${farPay.uniqueId}&callbackUrl=${encodeURIComponent(
    callbackUrl
  )}`;
  return { deepLinkUrl, uniqueId: farPay.uniqueId };
};

const searchCastHandleByMatch = async (handle, limit = 10, sort = "text") => {
  if (!handle) return [];
  const handleEscaped = escapeRegExp(handle.toLowerCase());

  let cacheKey = `searchCastHandleByMatch:${handle}`;

  const data = await memcache.get(getHash(cacheKey));
  if (data) {
    return JSON.parse(data.value);
  }

  let castHandles;
  if (process.env.NODE_ENV === "development") {
    castHandles = await CastHandle.find({
      handle: { $regex: `^${handleEscaped}`, $options: "i" },
    })
      .read("secondaryPreferred")
      .limit(limit)
      .sort(sort);
  } else {
    try {
      castHandles = await CastHandle.aggregate()
        .search({
          text: {
            query: handle,
            path: "handle",
            fuzzy: {
              maxEdits: 2,
              prefixLength: 0,
              maxExpansions: 50,
            },
          },
          index: "search-casthandles",
        })
        .limit(limit);
    } catch (e) {
      console.error("Error searching casthandles", e);
      Sentry.captureException(e);
      return [];
    }
  }

  const result = castHandles.map((ch) => ({
    handle: ch.handle,
    owner: ch.owner,
    tokenId: ch.tokenId,
    // Add any other relevant fields you want to include
  }));

  await memcache.set(getHash(cacheKey), JSON.stringify(result), {
    lifetime: 60 * 5, // 5m cache
  });

  return result;
};

const getUserNotificationDetails = async ({ fid, appFid, webhookId }) => {
  if (!fid || !appFid || !webhookId) {
    throw new Error("Missing required fields");
  }
  const frameNotification = await FrameNotification.findOne({
    fid,
    appFid,
    webhookId,
    valid: true,
  });
  return frameNotification?.notificationDetails;
};

const setUserNotificationDetails = async ({
  fid,
  appFid,
  webhookId,
  notificationDetails,
}) => {
  if (!fid || !appFid || !webhookId || !notificationDetails) {
    throw new Error("Missing required fields");
  }
  await FrameNotification.updateOne(
    { fid, appFid, webhookId },
    { notificationDetails, valid: true },
    { upsert: true }
  );
};

const deleteUserNotificationDetails = async ({ fid, appFid, webhookId }) => {
  if (!fid || !appFid || !webhookId) {
    throw new Error("Missing required fields");
  }
  await FrameNotification.updateOne(
    { fid, appFid, webhookId, valid: true },
    { valid: false }
  );
};

const sendFrameNotification = async ({
  fid,
  appFid,
  webhookId,
  title,
  body = "",
  targetUrl = "",
  notificationId = null,
}) => {
  if (!fid || !appFid || !webhookId || !title) {
    throw new Error("Missing required fields");
  }
  const notificationDetails = await getUserNotificationDetails({
    fid,
    appFid,
    webhookId,
  });
  if (!notificationDetails) {
    console.log("No notification details found for FID:", fid, appFid);
    return { state: "no_token" };
  }

  try {
    const response = await fetch(notificationDetails.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        notificationId: notificationId || crypto.randomUUID(),
        title,
        body,
        targetUrl,
        tokens: [notificationDetails.token],
      }),
    });

    const responseBody = await response.json();

    console.log("responseBody", responseBody);

    if (response.status === 200) {
      return { state: "success" };
    }

    return { state: "error", error: responseBody };
  } catch (error) {
    console.error("Error sending frame notification:", error);
    return { state: "error", error };
  }
};

/**
 * Gets the primary address from a profile object based on a priority order:
 * 1. primaryAddress field if present
 * 2. If external is true, use custodyAddress
 * 3. If external is false, look for connectedAddress or first address in allConnectedAddresses.ethereum
 * 4. Fallback to custodyAddress
 *
 * @param {Object} profile - The profile object
 * @returns {string} The primary address
 */
function getFarcasterUserPrimaryAddress(profile) {
  if (!profile) return null;

  // 1. Check primaryAddress field
  if (profile.primaryAddress) {
    return profile.primaryAddress;
  }

  // 2. If external, use fid
  if (profile.external) {
    return profile.fid;
  }

  // 3. For non-external profiles, check connectedAddress and allConnectedAddresses
  if (profile.connectedAddress) {
    return profile.connectedAddress;
  }

  // Check allConnectedAddresses.ethereum
  if (profile.allConnectedAddresses?.ethereum?.length > 0) {
    return profile.allConnectedAddresses.ethereum[0];
  }

  // 4. Fallback to custodyAddress
  return profile.custodyAddress;
}

module.exports = {
  getFarcasterUserByFid,
  getFarcasterUserByUsername,
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
  getCustodyAddressByFid,
  getFarcasterUserByCustodyAddress,
  getFarcasterNotifications,
  getFarcasterUnseenNotificationsCount,
  getFarcasterUserAndLinksByFid,
  getFarcasterUserAndLinksByUsername,
  getFarcasterUserByConnectedAddress,
  getConnectedAddressForFid,
  getConnectedAddressesForFid,
  postMessage,
  searchFarcasterUserByMatch,
  GLOBAL_SCORE_THRESHOLD,
  GLOBAL_SCORE_THRESHOLD_CHANNEL,
  getFarcasterFidByCustodyAddress,
  getFarcasterUserByAddress,
  getFarcasterStorageByFid,
  getFidMetadataSignature,
  getFrame,
  getFrames,
  createReport,
  getSyncedChannelById,
  getSyncedChannelByUrl,
  searchChannels,
  searchFarcasterCasts,
  isFollowingChannel,
  getActions,
  createAction,
  getFarcasterSignersForFid,
  getFarcasterReactionsCount,
  getFarcasterFollowersCount,
  getFarcasterRepliesCount,
  getFarPay,
  getFarpayDeeplink,
  updateFarPay,
  searchCastHandleByMatch,
  getFarcasterUserByAnyAddress,
  getFarcasterL1UserByAnyAddress,
  getUserNotificationDetails,
  setUserNotificationDetails,
  deleteUserNotificationDetails,
  sendFrameNotification,
  getFarcasterUserPrimaryAddress,
};
