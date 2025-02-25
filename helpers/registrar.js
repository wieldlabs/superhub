const BebRegistryBetaController = require("./abi/beb-controller-abi.json");
const BebRegistrar = require("./abi/beb-registrar-abi.json");
const BebFactoryContract = require("./abi/beb-account-factory-0.json");
const OPBebRegistryBetaController = require("./abi/op-controller-abi.json");
const BaseBebRegistryBetaController = require("./abi/base-controller-abi.json");

const dev = () => {
  return {
    NODE_URL: process.env.HOMESTEAD_NODE_URL,
    NODE_NETWORK: "homestead",
    OPTIMISM_CONTROLLER_ADDRESS: "0x8db531fe6bea7b474c7735879e9a1000e819bd1d",
    BETA_CONTROLLER_ADDRESS: "0x0F08FC2A63F4BfcDDfDa5c38e9896220d5468a64",
    REGISTRAR_ADDRESS: "0x427b8efEe2d6453Bb1c59849F164C867e4b2B376",
    PRICE_ORACLE_ADDRESS: "0x8d881B939cEb6070a9368Aa6D91bc42e30697Da9",
    BETA_CONTROLLER_ABI: BebRegistryBetaController.abi,
    OPTIMISM_CONTROLLER_ABI: OPBebRegistryBetaController.abi,
    REGISTRAR_ABI: BebRegistrar.abi,
    // version 0 / SimpleAccountFactory.sol
    FACTORY_CONTRACT_ADDRESS: "0xf6DdB44376Cc2f3Ed90625357991e10200eb3701",
    ENTRYPOINT_ADDRESS: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
    FACTORY_ABI: BebFactoryContract.abi,
    OPTIMISM_NODE_URL: process.env.OPTIMISM_NODE_URL,
    OPTIMISM_REGISTRAR_ADDRESS: "0xd14005cb9b40a1b7104eacdeae36f7fe112fae5f",
    OPTIMISM_NODE_NETWORK: "opt-mainnet",
    BASE_NODE_URL: process.env.BASE_NODE_URL,
    BASE_NODE_NETWORK: "base-mainnet",
    BASE_REGISTRAR_ADDRESS: "0xf2b35faadbcded342a1a4f1e6c95b977e85439fa",
    BASE_CONTROLLER_ADDRESS: "0xdd7672abb72542fd30307159bd898a273b1a14af",
    BASE_CONTROLLER_ABI: BaseBebRegistryBetaController.abi,
    FARCAST_FID: 18548,
    FARCAST_STAGING_FID: 0,
    FARCAST_KEY: process.env.FARCAST_KEY,
    MOCK_SIGNER_KEY:
      "divert visual loan bachelor ready enlist put into tray camera left six",
    SHOULD_CREATE_PACKS: true,
    PACK_SET: "Genesis",
  };
};

const prod = () => {
  return {
    NODE_URL: process.env.HOMESTEAD_NODE_URL,
    NODE_NETWORK: "homestead",
    OPTIMISM_CONTROLLER_ADDRESS: "0x8db531fe6bea7b474c7735879e9a1000e819bd1d",
    BETA_CONTROLLER_ADDRESS: "0x0F08FC2A63F4BfcDDfDa5c38e9896220d5468a64",
    REGISTRAR_ADDRESS: "0x427b8efEe2d6453Bb1c59849F164C867e4b2B376",
    OPTIMISM_REGISTRAR_ADDRESS: "0xd14005cb9b40a1b7104eacdeae36f7fe112fae5f",
    OPTIMISM_NODE_URL: process.env.OPTIMISM_NODE_URL,
    OPTIMISM_NODE_NETWORK: "opt-mainnet",
    PRICE_ORACLE_ADDRESS: "0x8d881B939cEb6070a9368Aa6D91bc42e30697Da9",
    BETA_CONTROLLER_ABI: BebRegistryBetaController.abi,
    OPTIMISM_CONTROLLER_ABI: OPBebRegistryBetaController.abi,
    REGISTRAR_ABI: BebRegistrar.abi,
    BASE_NODE_URL: process.env.BASE_NODE_URL,
    BASE_NODE_NETWORK: "base-mainnet",
    BASE_REGISTRAR_ADDRESS: "0xf2b35faadbcded342a1a4f1e6c95b977e85439fa",
    BASE_CONTROLLER_ADDRESS: "0xdd7672abb72542fd30307159bd898a273b1a14af",
    BASE_CONTROLLER_ABI: BaseBebRegistryBetaController.abi,
    FARCAST_FID: 18548,
    FARCAST_KEY: process.env.FARCAST_KEY,
    FARCAST_STAGING_FID: 0,
    MOCK_SIGNER_KEY:
      "divert visual loan bachelor ready enlist put into tray camera left six",
    SHOULD_CREATE_PACKS: true,
    PACK_SET: "Genesis",
  };
};

const config = process.env.NODE_ENV === "production" ? prod : dev;
module.exports = { config, prod, dev };
