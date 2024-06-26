const Sentry = require("@sentry/node"), getGraphQLRateLimiter = require("graphql-rate-limit")["getGraphQLRateLimiter"], _CommunityQuestMutationService = require("../../../services/mutationServices/CommunityQuestMutationService")["Service"], unauthorizedErrorOrAccount = require("../../../helpers/auth-middleware")["unauthorizedErrorOrAccount"], _AlchemyService = require("../../../services/AlchemyService")["Service"], Account = require("../../../models/Account")["Account"], prod = require("../../../helpers/registrar")["prod"], {
  memcache,
  getHash
} = require("../../../connectmemcache"), getAddressPasses = require("../../../helpers/farcaster-utils")["getAddressPasses"], rateLimiter = getGraphQLRateLimiter({
  identifyContext: e => e.id
}), RATE_LIMIT_MAX = 1e4, resolvers = {
  Mutation: {
    claimReward: async (e, r, t, s) => {
      s = await rateLimiter({
        root: e,
        args: r,
        context: t,
        info: s
      }, {
        max: RATE_LIMIT_MAX,
        window: "10s"
      });
      if (s) throw new Error(s);
      s = await unauthorizedErrorOrAccount(e, r, t);
      if (!s.account) return s;
      try {
        var a = (await new _CommunityQuestMutationService().claimRewardOrError(e, {
          communityId: r.communityId,
          questId: r.questId,
          questData: r.questData
        }, t))["communityQuest"], c = `CommunityQuestService:checkIfCommunityQuestClaimedByAddress${a._id}:` + (t.accountId || t.account?._id);
        return await memcache.set(c, "true"), {
          communityQuest: a,
          code: "201",
          success: !0,
          message: "Successfully claimed quest reward"
        };
      } catch (e) {
        return (e.message || "").includes("Reward cannot be claimed at this time") || (Sentry.captureException(e), 
        console.error(e)), {
          code: "500",
          success: !1,
          message: e.message
        };
      }
    },
    claimRewardByAddress: async (e, r, t, s) => {
      s = await rateLimiter({
        root: e,
        args: r,
        context: t,
        info: s
      }, {
        max: RATE_LIMIT_MAX,
        window: "10s"
      });
      if (s) throw new Error(s);
      try {
        var a, c, i, o = (await getAddressPasses(r.address, !0))["isHolder"];
        return o ? (a = await Account.findOrCreateByAddressAndChainId({
          address: r.address,
          chainId: 1
        }), {
          communityQuest: c,
          rewards: i
        } = await new _CommunityQuestMutationService().claimRewardOrError(e, {
          communityId: r.communityId,
          questId: r.questId,
          questData: r.questData
        }, {
          ...t,
          account: a
        }), {
          communityQuest: c,
          rewards: i,
          code: "201",
          success: !0,
          message: "Successfully claimed quest reward"
        }) : {
          code: "500",
          success: !1,
          message: "You can only claim the reward if you hold a .cast handle in your address."
        };
      } catch (e) {
        return (e.message || "").includes("Reward cannot be claimed at this time") || (Sentry.captureException(e), 
        console.error(e)), {
          code: "500",
          success: !1,
          message: e.message
        };
      }
    },
    claimCommunityRewardByAddress: async (e, r, t, s) => {
      s = await rateLimiter({
        root: e,
        args: r,
        context: t,
        info: s
      }, {
        max: RATE_LIMIT_MAX,
        window: "10s"
      });
      if (s) throw new Error(s);
      try {
        var a, c, i = (await getAddressPasses(r.address, !0))["isHolder"];
        return i ? (a = await Account.findOrCreateByAddressAndChainId({
          address: r.address,
          chainId: 1
        }), c = (await new _CommunityQuestMutationService().claimCommunityRewardOrError(e, {
          communityRewardId: r.communityRewardId
        }, {
          ...t,
          account: a
        }))["communityQuest"], {
          communityQuest: c,
          code: "201",
          success: !0,
          message: "Successfully claimed quest reward"
        }) : {
          code: "500",
          success: !1,
          message: "You can only claim the reward if you hold a .cast handle in your address."
        };
      } catch (e) {
        return (e.message || "").includes("Reward cannot be claimed at this time") || (Sentry.captureException(e), 
        console.error(e)), {
          code: "500",
          success: !1,
          message: e.message
        };
      }
    }
  }
};

module.exports = {
  resolvers: resolvers
};