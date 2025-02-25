const mongoose = require("mongoose");

// We will use Online Archive instead of pruning Farcaster data - we don't want to lose any data!
// https://www.mongodb.com/docs/atlas/online-archive/manage-online-archive/

// HubSubscriptions
const hubSubscriptionsSchema = new mongoose.Schema({
  host: { type: String, required: true, unique: true },
  lastEventId: Number,
  lastBackfillFid: Number,
});
hubSubscriptionsSchema.index({ lastEventId: 1 });
hubSubscriptionsSchema.index({ lastBackfillFid: 1 });

// Messages
const messagesSchema = new mongoose.Schema(
  {
    deletedAt: Date,
    prunedAt: Date,
    revokedAt: Date,
    timestamp: { type: Date, required: true },
    messageType: Number,
    fid: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    hashScheme: Number,
    signature: { type: String, required: true },
    signatureScheme: Number,
    signer: { type: String, required: true },
    raw: { type: String, required: true },
    external: { type: Boolean, default: false },
    unindexed: { type: Boolean, default: false }, // We only use this Message schema for unindexed=true (external, messages posted from our client) - Farcaster-messages are checked for duplicates in memcache
    bodyOverrides: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);
messagesSchema.index({ unindexed: 1 });
messagesSchema.index(
  { deletedAt: 1 },
  {
    name: "expireDeleted",
    expireAfterSeconds: 0,
  }
);
messagesSchema.index(
  { prunedAt: 1 },
  {
    name: "expirePruned",
    expireAfterSeconds: 0,
  }
);
messagesSchema.index(
  { revokedAt: 1 },
  {
    name: "expireRevoked",
    expireAfterSeconds: 0,
  }
);
messagesSchema.index(
  { timestamp: 1 },
  {
    name: "expireMessages",
    expireAfterSeconds: 60 * 60 * 24 * 7,
  }
); // purge messages after 7 days - if we sync an older message as new the worst case we rewrite the data, but that's safe.

// Casts
const castsSchema = new mongoose.Schema(
  {
    deletedAt: Date,
    timestamp: { type: Date, required: true },
    fid: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    parentHash: String,
    parentFid: String,
    parentUrl: String,
    text: { type: String, default: "" },
    embeds: String,
    mentions: [String],
    mentionsPositions: [Number],
    external: { type: Boolean, default: false },
    threadHash: { type: String },
    globalScore: { type: Number, default: 0 },
    castType: { type: Number, default: 0 }, // enum CastType { CAST = 0; LONG_CAST = 1; }
    tag: { type: String },
  },
  { timestamps: true }
);

castsSchema.index({ parentHash: 1, deletedAt: 1 });
castsSchema.index({ fid: 1, hash: 1, deletedAt: 1 });
castsSchema.index({ fid: 1, deletedAt: 1, timestamp: -1 });
castsSchema.index({ mentions: 1, fid: 1, deletedAt: 1, timestamp: -1 });
castsSchema.index({
  parentUrl: 1,
  deletedAt: 1,
  timestamp: -1,
  globalScore: 1,
});
castsSchema.index({ timestamp: 1, _id: 1, external: 1 });
castsSchema.index({
  threadHash: 1,
  deletedAt: 1,
  timestamp: -1,
  parentHash: 1,
}); // for getFarcasterCastsInThread
castsSchema.index({
  tag: 1,
  deletedAt: 1,
  timestamp: -1,
});
castsSchema.index({ external: 1, _id: 1, timestamp: 1 }); // for generate-trending

const reactionsSchema = new mongoose.Schema(
  {
    deletedAt: Date,
    timestamp: { type: Date, required: true },
    reactionType: Number,
    fid: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    targetHash: String,
    targetFid: String,
    targetUrl: String,
    external: { type: Boolean, default: false },
  },
  { timestamps: true }
);

reactionsSchema.index({ timestamp: 1 }); // For MongoDB Online Archive
reactionsSchema.index({ targetHash: 1, reactionType: 1, deletedAt: 1 });
reactionsSchema.index({ targetFid: 1, reactionType: 1, deletedAt: 1 });
reactionsSchema.index({ reactionType: 1, fid: 1, targetHash: 1, deletedAt: 1 });
reactionsSchema.index({ reactionType: 1, fid: 1, targetUrl: 1 });

const signersSchema = new mongoose.Schema(
  {
    deletedAt: Date,
    timestamp: { type: Date, required: true },
    fid: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    custodyAddress: { type: String, required: true },
    signer: { type: String, required: true },
    name: String,
    external: { type: Boolean, default: false },
  },
  { timestamps: true }
);
signersSchema.index({ fid: 1, signer: 1 });

const claimSchema = new mongoose.Schema(
  {
    address: String,
    claimSignature: String,
    ethSignature: String, // deprecated for claimSignature
    blockHash: String,
    protocol: Number, // 0 = ETH, 1 = SOLANA, undefined = ETH
  },
  { _id: false }
);

const verificationsSchema = new mongoose.Schema(
  {
    deletedAt: Date,
    timestamp: { type: Date, required: true },
    fid: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    claim: { type: String, required: true },
    claimObj: { type: claimSchema },
    external: { type: Boolean, default: false },
  },
  { timestamps: true }
);
verificationsSchema.index({ fid: 1, claim: "text", deletedAt: 1 });
verificationsSchema.index({ claim: "text", deletedAt: 1 });
verificationsSchema.index({ fid: 1, deletedAt: 1 });
verificationsSchema.index({ deletedAt: 1 });
verificationsSchema.index({ claimObj: 1, deletedAt: 1 });
verificationsSchema.index({ "claimObj.address": 1, deletedAt: 1 });
verificationsSchema.index({
  "claimObj.protocol": 1,
  deletedAt: 1,
  fid: 1,
  timestamp: 1,
});
verificationsSchema.index({
  deletedAt: 1,
  fid: 1,
  timestamp: 1,
});

const userDataSchema = new mongoose.Schema(
  {
    deletedAt: Date,
    timestamp: { type: Date, required: true },
    fid: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    type: { type: Number, required: true },
    value: { type: String, required: true },
    text: { type: String },
    external: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userDataSchema.index({ fid: 1, type: 1 });
userDataSchema.index({ fid: 1, deletedAt: 1 });
// WARNING: You can only have one text index per collection!
userDataSchema.index({ text: "text", type: 1, deletedAt: 1 });
userDataSchema.index({ fid: 1, type: 1, deletedAt: 1 });
userDataSchema.index({ deletedAt: 1, value: 1 });
userDataSchema.index({ type: 1, external: 1, deletedAt: 1, value: 1 });
userDataSchema.index({ fid: 1, external: 1, deletedAt: 1, value: 1 });

const fidsSchema = new mongoose.Schema(
  {
    fid: { type: String, required: true, unique: true },
    custodyAddress: { type: String, required: true },
    external: { type: Boolean, default: false },
    timestamp: { type: Date },
    nerfed: { type: Boolean, default: false },
  },
  { timestamps: true }
);
fidsSchema.index({ custodyAddress: 1, deletedAt: 1 });
fidsSchema.index({ createdAt: 1 });

const fnamesSchema = new mongoose.Schema(
  {
    fname: { type: String, required: true, unique: true },
    fid: { type: String },
    custodyAddress: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    external: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

fnamesSchema.index({ fname: 1, deletedAt: 1 });
fnamesSchema.index({ custodyAddress: 1, deletedAt: 1 });
fnamesSchema.index({ fid: 1, deletedAt: 1 });

const linksSchema = new mongoose.Schema(
  {
    fid: { type: String, required: true },
    targetFid: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    timestamp: { type: Date, required: true },
    deletedAt: Date,
    type: { type: String, required: true },
    displayTimestamp: Date,
    external: { type: Boolean, default: false },
  },
  { timestamps: true }
);
linksSchema.index({ fid: 1, targetFid: 1, type: 1 });
linksSchema.index({ fid: 1, type: 1, deletedAt: 1, timestamp: -1 });
linksSchema.index({
  targetFid: 1,
  type: 1,
  deletedAt: 1,
  timestamp: -1,
});
linksSchema.index(
  { deletedAt: 1 },
  {
    name: "expireDeleted",
    expireAfterSeconds: 0,
  }
);

const storageSchema = new mongoose.Schema(
  {
    deletedAt: Date,
    timestamp: { type: Date, required: true },
    fid: { type: String, required: true },
    units: { type: Number, required: true },
    expiry: { type: Date, required: true },
  },
  {
    timestamps: true,
  }
);
storageSchema.index({ fid: 1, deletedAt: 1 });
storageSchema.index(
  { deletedAt: 1 },
  {
    name: "expireDeleted",
    expireAfterSeconds: 0,
  }
);

const notificationsSchema = new mongoose.Schema(
  {
    // Timestamp when the notification was generated
    timestamp: { type: Date, required: true },

    // Type of the notification (follow, reaction, reply, etc.)
    notificationType: {
      type: String,
      required: true,
      enum: ["link", "reply", "reaction", "mention"],
    },

    // FID (Farcaster ID) of the user who generated the notification
    fromFid: { type: String, required: true },

    // FID of the user who will receive the notification
    toFid: { type: String, required: true },

    // Optional additional data relevant to the notification
    payload: { type: mongoose.Schema.Types.Mixed },

    // Flag to mark if the notification was deleted
    deletedAt: Date,

    // Flag to mark if the notification is external
    external: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Indexes for faster queries
notificationsSchema.index({
  toFid: 1,
  fromFid: 1,
  notificationType: 1,
  deletedAt: 1,
});
notificationsSchema.index(
  { deletedAt: 1 },
  {
    name: "expireDeleted",
    expireAfterSeconds: 0,
  }
);
notificationsSchema.index(
  { timestamp: 1 },
  {
    name: "expireNotifications",
    expireAfterSeconds: 60 * 60 * 24 * 30,
  }
); // purge notifications after 30 days
notificationsSchema.index({
  "payload.castHash": 1,
  notificationType: 1,
  fromFid: 1,
  toFid: 1,
}); // for better notification updateOne

const offerSchema = new mongoose.Schema(
  {
    buyerAddress: { type: String, required: true },
    fid: { type: Number, required: true },
    deadline: { type: String, required: true },
    canceledAt: { type: Date },
    txHash: { type: String },
    amount: { type: String, required: true },
    tokenId: { type: String }, // used for ERC721s like cast handles
    chainId: { type: Number, default: 10 }, // used for ERC721s like cast handles
  },
  { timestamps: true }
);

offerSchema.index({ buyerAddress: 1, canceledAt: 1 });
offerSchema.index({ buyerAddress: 1, fid: 1 });
offerSchema.index({ buyerAddress: 1, fid: 1, canceledAt: 1 });
offerSchema.index({ fid: 1, canceledAt: 1 });
offerSchema.index({ tokenId: 1, chainId: 1, canceledAt: 1 });
offerSchema.index({ txHash: 1 });
offerSchema.index({ canceledAt: 1 });
offerSchema.index({ canceledAt: 1, amount: -1 });
offerSchema.index({ chainId: 1, canceledAt: 1, amount: -1 });
offerSchema.index({ fid: 1, canceledAt: 1, amount: -1 });
offerSchema.index({ tokenId: 1, chainId: 1, canceledAt: 1, amount: -1 });

const listingSchema = new mongoose.Schema(
  {
    ownerAddress: { type: String, required: true },
    fid: { type: Number, required: true }, // if it is a .cast handle fid is -1
    minFee: { type: String, required: true },
    deadline: { type: Number, required: true },
    txHash: { type: String },
    canceledAt: { type: Date },
    tokenId: { type: String }, // used for ERC721s like cast handles
    chainId: { type: Number, default: 10 }, // used for ERC721s like cast handles
  },
  { timestamps: true }
);

listingSchema.index({ ownerAddress: 1, canceledAt: 1 });
listingSchema.index({ fid: 1, canceledAt: 1 });
listingSchema.index({ tokenId: 1, chainId: 1, canceledAt: 1 });
listingSchema.index({ tokenId: 1, chainId: 1 });
listingSchema.index({ canceledAt: 1 });
listingSchema.index({ fid: 1, canceledAt: 1, txHash: 1 });
listingSchema.index({ fid: 1, txHash: 1 });
listingSchema.index({ fid: 1, boughtAt: 1 });
listingSchema.index({ fid: 1, deadline: 1, canceledAt: 1 });
listingSchema.index({ fid: 1, ownerAddress: 1, deadline: 1, canceledAt: 1 });
listingSchema.index({ fid: 1, boughtAt: 1, canceledAt: 1 });
listingSchema.index({ fid: 1, boughtAt: 1, canceledAt: 1, createdAt: 1 });
listingSchema.index({ canceledAt: 1, createdAt: 1, deadline: 1 });
listingSchema.index({ canceledAt: 1, boughtAt: 1, deadline: 1, fid: 1 });
listingSchema.index({ canceledAt: 1, boughtAt: 1, deadline: 1, fid: 1, id: 1 });
listingSchema.index({ canceledAt: 1, id: 1, deadline: 1 });
listingSchema.index({ canceledAt: 1, id: 1, deadline: 1, fid: 1 });
listingSchema.index({ canceledAt: 1, id: 1, deadline: 1, fid: 1, minFee: 1 });
listingSchema.index({
  canceledAt: 1,
  updatedAt: -1,
  _id: 1,
  deadline: 1,
  fid: 1,
});
listingSchema.index({
  canceledAt: 1,
  minFee: 1,
  _id: 1,
  deadline: 1,
  fid: 1,
});
listingSchema.index({
  canceledAt: 1,
  minFee: -1,
  _id: 1,
  deadline: 1,
  fid: 1,
});
listingSchema.index({
  canceledAt: 1,
  fid: 1,
  _id: 1,
  deadline: 1,
});
listingSchema.index({
  canceledAt: 1,
  fid: -1,
  _id: 1,
  deadline: 1,
});
listingSchema.index({
  canceledAt: 1,
  updatedAt: 1,
  _id: 1,
  deadline: 1,
  fid: 1,
});

listingSchema.post("find", function (docs) {
  for (let doc of docs) {
    doc.minFee = doc.minFee.replace(/^0+/, ""); // This will remove all leading zeros
  }
});

listingSchema.post("findOne", function (doc) {
  if (doc) {
    doc.minFee = doc.minFee.replace(/^0+/, ""); // This will remove all leading zeros
  }
});

const listingLogSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      required: true,
      enum: [
        "Listed",
        "Bought",
        "Canceled",
        "OfferMade",
        "OfferCanceled",
        "OfferApproved",
      ],
    }, // "Listed" or "Bought"
    fid: { type: Number, required: true },
    from: { type: String }, // initiator of the event
    txHash: { type: String },
    price: {
      type: String,
    },
    referrer: { type: String },
    tokenId: { type: String }, // used for ERC721s like cast handles
    chainId: { type: Number, default: 10 }, // used for ERC721s like cast handles
  },
  { timestamps: true }
);

listingLogSchema.index({
  price: -1,
});

listingLogSchema.index({
  txHash: 1,
});

listingLogSchema.index({
  fid: 1,
});

listingLogSchema.index({
  tokenId: 1,
  chainId: 1,
});

listingLogSchema.index({
  txHash: 1,
  chainId: 1,
});

listingLogSchema.index({
  from: 1,
  eventType: 1,
});
listingLogSchema.index({
  fid: 1,
  eventType: 1,
});
listingLogSchema.index({
  referrer: 1,
});
listingLogSchema.index({
  referrer: 1,
  eventType: 1,
  createdAt: 1,
});
listingLogSchema.index({
  eventType: 1,
});
listingLogSchema.index({
  fid: 1,
  eventType: 1,
  createdAt: 1,
});
listingLogSchema.index({
  eventType: 1,
  createdAt: 1,
});

const appraisalSchema = new mongoose.Schema(
  {
    fid: { type: String, required: true },
    amount: { type: String, required: true },
    appraisedBy: { type: String },
  },
  { timestamps: true }
);

appraisalSchema.index({ fid: 1 });
const frameButtonSchema = new mongoose.Schema({
  text: { type: String },
  target: { type: String },
  action: { type: String },
});
const framesSchema = new mongoose.Schema(
  {
    frameButton1: frameButtonSchema,
    frameButton2: frameButtonSchema,
    frameButton3: frameButtonSchema,
    frameButton4: frameButtonSchema,
    frameImageUrl: { type: String },
    framePostUrl: { type: String },
    image: { type: String },
    title: { type: String },
    sourceUrl: { type: String },
    description: { type: String },
    domain: { type: String },
    hash: { type: String },
    frameInputText: { type: String },
  },
  { timestamps: true }
);

framesSchema.index({ sourceUrl: 1 });
framesSchema.index({ hash: 1 });
framesSchema.index({ title: 1 });
framesSchema.index(
  { createdAt: 1 },
  {
    name: "expireFrames",
    expireAfterSeconds: 60 * 60 * 24 * 7,
  }
); // purge frames after 7 days

const reportsSchema = new mongoose.Schema(
  {
    fid: { type: String, required: true },
    reason: { type: String },
    count: { type: Number, default: 0 },
    reporters: { type: [String] },
  },
  { timestamps: true }
);
reportsSchema.index({ fid: 1 });

const syncedChannelsSchema = new mongoose.Schema(
  {
    channelId: { type: String, required: true },
    url: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    imageUrl: { type: String },
    leadFid: { type: String },
    createdAt: { type: Number },
    followerCount: { type: Number, default: 0, index: true },
    hostFids: { type: [String] },
  },
  { timestamps: false }
);

syncedChannelsSchema.index({ channelId: 1 });
syncedChannelsSchema.index({ name: 1 });
syncedChannelsSchema.index({ url: 1 });
syncedChannelsSchema.index({ createdAt: 1 });
// Add text index for better search performance (SyncedChannels.searchChannels)
syncedChannelsSchema.index({ channelId: "text" });

const syncedActionsSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    icon: { type: String },
    description: { type: String },
    aboutUrl: { type: String },
    actionUrl: { type: String, required: true },
    rank: {
      // rank by installs
      type: Number,
      index: true,
    },
    action: {
      actionType: { type: String },
      postUrl: { type: String },
    },
  },
  { timestamps: true }
);

syncedActionsSchema.index({ name: 1 });
syncedActionsSchema.index({ actionUrl: 1 });
syncedActionsSchema.index({ "action.actionType": 1 });

const syncedVerificationSchema = new mongoose.Schema(
  {
    fid: { type: String, required: true },
    verified: { type: Boolean, default: false },
    timestamp: { type: Date },
  },
  { timestamps: true }
);
syncedVerificationSchema.index({ verified: 1 });
syncedVerificationSchema.index({ fid: 1 });
syncedVerificationSchema.index({ fid: 1, verified: 1 });
syncedVerificationSchema.index(
  { updatedAt: 1 },
  {
    expireAfterSeconds: 7 * 24 * 60 * 60, // 7 days in seconds
  }
);

const farpaySchema = new mongoose.Schema(
  {
    uniqueId: { type: String, index: true },
    txId: { type: String, required: true, index: true },
    data: { type: String },
    txHash: { type: String, index: true },
    callbackUrl: { type: String },
  },
  { timestamps: true }
);

const frameNotificationSchema = new mongoose.Schema(
  {
    fid: { type: String, required: true },
    appFid: { type: String, required: true },
    webhookId: { type: String, required: true },
    notificationDetails: {
      url: { type: String, required: true },
      token: { type: String, required: true },
    },
    valid: { type: Boolean, default: false },
  },
  { timestamps: true }
);

frameNotificationSchema.index({ fid: 1, appFid: 1, webhookId: 1 });
frameNotificationSchema.index({ fid: 1, appFid: 1, webhookId: 1, valid: 1 });
frameNotificationSchema.index({ valid: 1 });
frameNotificationSchema.index({ fid: 1, valid: 1 });

// Don't add semi-relevant stuff here unless absolutely necessary and related to Farcaster data
module.exports = {
  hubSubscriptionsSchema,
  messagesSchema,
  castsSchema,
  reactionsSchema,
  signersSchema,
  verificationsSchema,
  userDataSchema,
  fidsSchema,
  fnamesSchema,
  linksSchema,
  notificationsSchema,
  offerSchema,
  listingSchema,
  storageSchema,
  appraisalSchema,
  listingLogSchema,
  framesSchema,
  reportsSchema,
  syncedChannelsSchema,
  syncedActionsSchema,
  syncedVerificationSchema,
  farpaySchema,
  frameNotificationSchema,
};
