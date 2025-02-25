const jwt = require("jsonwebtoken");

const generateNewAccessTokenFromAccount = (account, extra = {}) => {
  if (!account || !account._id) throw new Error("Invalid Account");

  return new Promise((resolve, reject) => {
    jwt.sign(
      {
        payload: {
          id: account._id,
          address: account.addresses[0].address,
          ...extra,
        },
      },
      process.env.JWT_SECRET,
      {
        algorithm: "HS256",
      },
      (err, token) => {
        if (err) {
          return reject(err);
        }
        if (!token) {
          return new Error("Empty token");
        }
        return resolve(token);
      }
    );
  });
};

const getConfig = () => {
  return {
    algorithms: ["HS256"],
    secret: process.env.JWT_SECRET,
  };
};

module.exports = {
  generateNewAccessTokenFromAccount,
  getConfig,
};
