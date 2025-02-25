const jwt = require("jsonwebtoken");

const { getConfig } = require("./jwt");

const { Account } = require("../models/Account");

const requireAuth = (tokenRaw) => {
  if (!tokenRaw || !tokenRaw.includes("Bearer ")) {
    throw new Error("jwt must be provided");
  }

  return new Promise((resolve, reject) => {
    jwt.verify(
      tokenRaw.slice(7),
      getConfig().secret,
      { ignoreExpiration: true },
      function (err, decoded) {
        if (err) return reject(err);
        return resolve(decoded);
      }
    );
  });
};

const unauthorizedResponse = {
  code: "403",
  success: false,
  message: "Unauthorized",
};

const signedInAccountIdOrNull = (context = {}) => {
  return context.accountId || context.account?._id || null;
};

const unauthorizedErrorOrAccount = async (root, args, context) => {
  const { accountId } = context;
  if (!accountId) {
    return unauthorizedResponse;
  }
  const account = await Account.findById(accountId);
  context.account = account;
  return {
    code: "200",
    success: true,
    account,
  };
};

const isAuthorizedToAccessResource = (parent, _, context, model) => {
  const currentAccountId = context.accountId || context.account?._id;
  if (!currentAccountId) return false;

  switch (model) {
    case "account": {
      const resourceBelongToAccount =
        parent?._id?.toString() === currentAccountId.toString();
      if (!resourceBelongToAccount) return false;
      break;
    }
    case "accountAddress":
      if (parent.account?.toString() !== currentAccountId) return false;
      break;
    case "accountThread":
      if (parent.account?.toString() !== currentAccountId) return false;
      break;
    default: {
      const resourceBelongToAccount =
        parent?._id?.toString() === currentAccountId.toString();
      if (!resourceBelongToAccount) return false;
      break;
    }
  }
  return true;
};

module.exports = {
  requireAuth,
  unauthorizedErrorOrAccount,
  unauthorizedResponse,
  isAuthorizedToAccessResource,
  signedInAccountIdOrNull,
};
