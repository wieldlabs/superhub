const crypto = require("crypto");
const { ethers } = require("ethers");

const getRandomUint256 = () => {
  return ethers.BigNumber.from(crypto.randomBytes(32)).toString();
};

module.exports = {
  getRandomUint256,
};
