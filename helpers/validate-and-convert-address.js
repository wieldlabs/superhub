const { ethers } = require("ethers");
const crypto = require("crypto");

/**
 * Validate address and convert it to a checksummed address
 * https://docs.ethers.io/v5/api/utils/address/
 * @returns String | Error
 */

const validatePemKey = (pemKey) => {
  try {
    crypto.createPublicKey(pemKey);
    return pemKey;
  } catch (e) {
    throw new Error("Invalid PEM key");
  }
};
const validateAndConvertAddress = (address, chainId = 1) => {
  if (!address) throw new Error("Invalid address");
  if (chainId == -7) {
    return validatePemKey(address);
  }
  try {
    return ethers.utils.getAddress(address);
  } catch (e) {
    throw new Error(e.message);
  }
};

const isAddress = (query) => {
  if (!query) return false;
  try {
    validateAndConvertAddress(query);
    return true;
  } catch (e) {
    return false;
  }
};
const isENS = (query) => {
  if (!query) return false;
  try {
    return query?.slice?.(-4) === ".eth";
  } catch (e) {
    return false;
  }
};

module.exports = { validateAndConvertAddress, isAddress, isENS };
