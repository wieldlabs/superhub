const chainTable = { 1: "Ethereum mainnet", "-7": "PassKey ES256" };

const mapChainIdToName = (chainId) => {
  return chainTable[chainId];
};

module.exports = { chainTable, mapChainIdToName };
