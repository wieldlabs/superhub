// Used to determine if a Transaction is a DEX swap on Base
// Banana Gun supported DEXs: https://docs.bananagun.io/miscellaneous/supported-dexes
const BASE_DEX_CONTRACTS = {
  "0x498581ff718922c3f8e6a244956af099b2652b2b": {
    // Uniswap V4 Pool Manager: https://docs.uniswap.org/contracts/v4/deployments
    name: "Uniswap",
    details: "Uniswap V4 Pool Manager",
  },
  // Uniswap V4 Universal Router: https://docs.uniswap.org/contracts/v4/deployments
  "0x6ff5693b99212da76ad316178a184ab56d299b43": {
    name: "Uniswap",
    details: "Uniswap V4 Universal Router",
  },
  "0x2626664c2603336E57B271c5C0b26F421741e481": {
    // Uniswap V3 Swap Router: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
    name: "Uniswap",
    details: "Uniswap V3 Swap Router",
  },
  "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD": {
    // Uniswap V3 Universal Router: https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
    name: "Uniswap",
    details: "Uniswap V3 Universal Router",
  },
  "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24": {
    // Uniswap V2 Router: https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments
    name: "Uniswap",
    details: "Uniswap V2 Router",
  },
  // Sushiswap contracts: https://dev.sushi.com/docs/Developers/Deployment%20Addresses
  "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891": {
    // https://dev.sushi.com/docs/Products/Classic%20AMM/Deployment%20Addresses
    name: "Sushiswap",
    details: "Sushiswap V2Router02",
  },
  "0x0389879e0156033202c44bf784ac18fc02edee4f": {
    // https://dev.sushi.com/docs/Products/Route%20Processor/Deployment%20Addresses
    name: "Sushiswap",
    details: "Sushiswap RouteProcessor4",
  },
  "0xf2614A233c7C3e7f08b1F887Ba133a13f1eb2c55": {
    // https://dev.sushi.com/docs/Products/Route%20Processor/Deployment%20Addresses
    name: "Sushiswap",
    details: "Sushiswap RouteProcessor5",
  },
  "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43": {
    // https://github.com/aerodrome-finance/contracts
    name: "Aerodrome",
    details: "Aerodrome Router",
  },
  "0x1B8eea9315bE495187D873DA7773a874545D9D48": {
    // https://docs.baseswap.fi/baseswap/info/smart-contracts
    name: "BaseSwap",
    details: "BaseSwap Router",
  },
  "0x78a087d713Be963Bf307b18F2Ff8122EF9A63ae9": {
    // https://docs.baseswap.fi/baseswap/info/smart-contracts
    name: "BaseSwap",
    details: "BaseSwap BSwap",
  },
  "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb": {
    // https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v2-contracts/router-v2
    name: "Pancakeswap",
    details: "Pancakeswap V2 Router",
  },
  "0x1b81D678ffb9C0263b24A97847620C99d213eB14": {
    // https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts
    name: "Pancakeswap",
    details: "Pancakeswap V3 Router",
  },
  "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86": {
    // https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts
    name: "Pancakeswap",
    details: "Pancakeswap Smart Router",
  },
  "0x6b2C0c7be2048Daa9b5527982C29f48062B34D58": {
    // 0x router: https://www.okx.com/web3/build/docs/waas/dex-smart-contract
    name: "0KX",
    details: "0KX Swap Router",
  },
  "0xBc3c5cA50b6A215edf00815965485527f26F5dA8": {
    // 0x router: https://0x.org/docs/1.0/developer-resources/contract-addresses
    // https://basescan.org/address/0xbc3c5ca50b6a215edf00815965485527f26f5da8
    name: "0x",
    details: "0x Router",
  },
  "0xF9c2b5746c946EF883ab2660BbbB1f10A5bdeAb4": {
    // https://docs.kyberswap.com/reference/legacy/kyberswap-elastic/contracts/elastic-contract-addresses
    name: "Kyber",
    details: "Kyber Elastic Router",
  },
  "0x4d47fd5a29904Dae0Ef51b1c450C9750F15D7856": {
    // https://docs.kyberswap.com/reference/legacy/kyberswap-elastic/contracts/elastic-contract-addresses
    name: "Kyber",
    details: "Kyber Quoter",
  },
  "0x794e6E9152449C4Ac4f2FE8200D471626F8f5FF7": {
    // https://docs.li.fi/smart-contracts/deployments
    name: "LiFi",
    details: "LiFi Router",
  },
};
const BASE_DEX_CONTRACTS_LOWERCASE = Object.fromEntries(
  Object.entries(BASE_DEX_CONTRACTS).map(([key, value]) => [
    key.toLowerCase(),
    value,
  ])
);

module.exports = {
  BASE_DEX_CONTRACTS,
  BASE_DEX_CONTRACTS_LOWERCASE,
};
