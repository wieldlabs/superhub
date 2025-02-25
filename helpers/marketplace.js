const MarketplaceV1 = require("./abi/marketplace-v1.json");
const MarketplaceV4 = require("./abi/marketplace-v4.json");
const MarketplaceV1Proxy = require("./abi/marketplace-v1-proxy.json");
const { abi: idRegistrarAbi } = require("./abi/id-registrar");
const NFTMarketplace = require("./abi/nft-marketplace-v1.json");

const dev = () => {
  return {
    WETH_ADDRESS: "0x4200000000000000000000000000000000000006",
    FID_MARKETPLACE_PROXY_V1_ABI: MarketplaceV1Proxy.abi,
    FID_MARKETPLACE_V1_ADDRESS: "0x57ce6c12a101c41e790744413f4f5408ac64d8c6",
    FID_MARKETPLACE_V1_ABI: MarketplaceV1.abi,
    FID_MARKETPLACE_V4_ABI: MarketplaceV4.abi,
    FID_MARKETPLACE_ABI: MarketplaceV4.abi,
    FID_ADDRESS: "0x00000000fcaf86937e41ba038b4fa40baa4b780a",
    CHAIN_ID: 10,
    NODE_URL: process.env.OPTIMISM_NODE_URL,
    NODE_NETWORK: 10,
    ID_REGISTRY_ABI: idRegistrarAbi,
    ID_REGISTRY_ADDRESS: "0x00000000fcaf86937e41ba038b4fa40baa4b780a",
    /** Farcaster v2 */
    ID_REGISTRY_ADDRESS_2: "0x00000000fc6c5f01fc30151999387bb99a9f489b",
    ID_GATEWAY_ADDRESS: "0x00000000fc25870c6ed6b6c7e41fb078b7656f69",
    USE_GATEWAYS: false,
    FID_MARKETPLACE_REF_PERCENTAGE: 2,

    /** NFT Marketplace */
    NFT_MARKETPLACE_ABI: NFTMarketplace.abi,
    NFT_MARKETPLACE_ADDRESS_OP: "0xc6581f8a9a3ca2f5e9e484f2623d30dd2cef34c9",
    NFT_MARKETPLACE_REF_PERCENTAGE: 2,
    ENABLE_NFT_MARKETPLACE: true,
  };
};

const prod = () => {
  return {
    WETH_ADDRESS: "0x4200000000000000000000000000000000000006",
    FID_MARKETPLACE_PROXY_V1_ABI: MarketplaceV1Proxy.abi,
    FID_MARKETPLACE_V1_ADDRESS: "0x57ce6c12a101c41e790744413f4f5408ac64d8c6",
    FID_MARKETPLACE_V1_ABI: MarketplaceV1.abi,
    FID_MARKETPLACE_V4_ABI: MarketplaceV4.abi,
    FID_MARKETPLACE_ABI: MarketplaceV4.abi,
    FID_ADDRESS: "0x00000000fcaf86937e41ba038b4fa40baa4b780a",
    CHAIN_ID: 10,
    NODE_URL: process.env.OPTIMISM_NODE_URL,
    NODE_NETWORK: 10,
    ID_REGISTRY_ABI: idRegistrarAbi,
    ID_REGISTRY_ADDRESS: "0x00000000fcaf86937e41ba038b4fa40baa4b780a",
    /** Farcaster v2 */
    ID_REGISTRY_ADDRESS_2: "0x00000000fc6c5f01fc30151999387bb99a9f489b",
    ID_GATEWAY_ADDRESS: "0x00000000fc25870c6ed6b6c7e41fb078b7656f69",
    USE_GATEWAYS: false,
    FID_MARKETPLACE_REF_PERCENTAGE: 2,

    /** NFT Marketplace */
    NFT_MARKETPLACE_ABI: NFTMarketplace.abi,
    NFT_MARKETPLACE_ADDRESS_OP: "0xc6581f8a9a3ca2f5e9e484f2623d30dd2cef34c9",
    NFT_MARKETPLACE_REF_PERCENTAGE: 2,
    ENABLE_NFT_MARKETPLACE: false,
  };
};

const config = process.env.NODE_ENV === "production" ? prod : dev;
// const config = prod;
module.exports = { config, prod, dev };
