const { ethers } = require("ethers");

const getProvider = ({ network, node }) => {
  if (network === "base-mainnet" || network === "base") {
    return new ethers.providers.JsonRpcProvider(
      "https://base-mainnet.g.alchemy.com/v2/" + node,
      {
        name: "base",
        chainId: 8453,
      }
    );
  }
  const finalNetwork = network === "opt-mainnet" ? "optimism" : network;
  if (node) {
    return new ethers.providers.AlchemyProvider(
      finalNetwork || "homestead",
      node
    );
  }
  return ethers.getDefaultProvider(finalNetwork || "homestead");
};

module.exports = {
  getProvider,
};
