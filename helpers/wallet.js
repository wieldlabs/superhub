const { prod } = require("./registrar");
const axios = require("axios");
const {
  Alchemy,
  Network,
  TokenBalanceType,
  SortingOrder,
} = require("alchemy-sdk");
const { memcache, getHash } = require("../connectmemcache");
const { normalizeTimeToRangeStart } = require("./timerange");
const {
  Service: MarketplaceService,
} = require("../services/MarketplaceService");
const { ethers } = require("ethers");
// TODO:
// 1. loop through all supported chains and update assets
// 2. delete all account inventory item that does not have the correct lastBlockHash, means they are e.g. transferred
async function getAccountAssets() {}

async function getOnchainNFTs(
  address,
  network,
  cursor,
  limit = DEFAULT_NFT_LIMIT
) {
  const data = await memcache.get(
    getHash(`Wallet_getOnchainNFTs:${limit}:${network}:${cursor}:${address}`)
  );
  if (data) {
    return JSON.parse(data.value);
  }

  const config = {
    apiKey: prod().NODE_URL,
    network,
  };

  const alchemy = new Alchemy(config);
  const params = {
    pageSize: limit,
  };
  if (cursor) {
    params.cursor = cursor;
  }
  const response = await alchemy.nft.getNftsForOwner(address, params);

  response.ownedNfts = response.ownedNfts.map((nft) => {
    // lets drop the originalUrl for SVG NFTs
    const image = nft.image;
    delete image.originalUrl;
    delete nft.raw;
    return nft;
  });

  await memcache.set(
    getHash(`Wallet_getOnchainNFTs:${limit}:${network}:${cursor}:${address}`),
    JSON.stringify(response),
    { lifetime: 24 * 60 * 60 } // 24 hours
  );

  return response;
}

async function getOnchainTokenMetadata(contractAddress, network) {
  const config = {
    apiKey: prod().NODE_URL,
    network,
  };
  const alchemy = new Alchemy(config);

  const data = await memcache.get(
    getHash(`Wallet_getOnchainTokenMetadata:${contractAddress}`)
  );
  if (data) {
    return JSON.parse(data.value);
  }

  const response = await alchemy.core.getTokenMetadata(contractAddress);

  await memcache.set(
    getHash(`Wallet_getOnchainTokenMetadata:${contractAddress}`),
    JSON.stringify(response),
    { lifetime: 24 * 60 * 60 } // 24 hours
  );

  return response;
}

// get all tokens owned by a wallet
async function getOnchainTokens(
  address,
  network,
  limit = DEFAULT_LIMIT,
  cursor = null,
  filterNoSymbol = DEFAULT_FILTER_NO_SYMBOL
) {
  const config = {
    apiKey: prod().NODE_URL,
    network,
  };

  const data = await memcache.get(
    getHash(
      `Wallet_getOnchainTokens:${limit}:${network}:${cursor}:${address}:${filterNoSymbol}`
    )
  );
  if (data) {
    return JSON.parse(data.value);
  }

  const alchemy = new Alchemy(config);
  const params = {
    type: TokenBalanceType.ERC20,
    pageSize: limit,
  };
  if (cursor) {
    params.pageKey = cursor;
  }
  const response = await alchemy.core.getTokenBalances(address, params);

  // for each token, get the token metadata with Promise.all and set it to response
  const tokenMetadataPromises = response.tokenBalances.map((token) =>
    getOnchainTokenMetadata(token.contractAddress, network)
  );

  const tokenMetadata = await Promise.all(tokenMetadataPromises);
  response.tokenBalances = response.tokenBalances.map((token, index) => ({
    ...token,
    metadata: tokenMetadata[index],
  }));

  // Filter out tokens with no symbol
  response.tokenBalances = response.tokenBalances.filter(
    (token) => token.metadata?.symbol
  );

  await memcache.set(
    getHash(
      `Wallet_getOnchainTokens:${limit}:${network}:${cursor}:${address}:${filterNoSymbol}`
    ),
    JSON.stringify(response),
    { lifetime: 60 * 60 } // 1 hour
  );

  // get all token balances, and retrieve relevant token data
  return response;
}

async function getOnchainTransactions(
  address,
  network,
  {
    cursor = null,
    category = ["erc20"],
    fromBlock = "0x0",
    limit = DEFAULT_LIMIT,
    order = SortingOrder.DESCENDING,
    withMetadata = true,
  }
) {
  const config = {
    apiKey: prod().NODE_URL,
    network,
  };

  const data = await memcache.get(
    getHash(
      `Wallet_getOnchainTransactions:${limit}:${network}:${cursor}:${address}`
    )
  );
  if (data) {
    return JSON.parse(data.value);
  }
  const alchemy = new Alchemy(config);
  const params = {
    fromBlock,
    toAddress: address,
    excludeZeroValue: true,
    category,
    limit,
    order,
    withMetadata,
  };
  if (cursor) {
    params.pageKey = cursor;
  }
  const response = await alchemy.core.getAssetTransfers(params);

  await memcache.set(
    getHash(
      `Wallet_getOnchainTransactions:${limit}:${network}:${cursor}:${address}`
    ),
    JSON.stringify(response),
    { lifetime: 60 * 60 } // 1 hour
  );

  return response;
}

function calculateTTL(timeRange) {
  switch (timeRange) {
    case "1h":
      return 60 * 60; // 1 hour in seconds
    case "1d":
      return 60 * 60 * 24; // 24 hours in seconds
    case "3d":
      return 60 * 60 * 24 * 3; // 3 days in seconds
    case "1w":
      return 60 * 60 * 24 * 7; // 7 days in seconds
    case "1m":
      return 60 * 60 * 24 * 30; // Roughly 30 days in seconds
    default:
      return 60 * 60; // Default 1 hour
  }
}

async function fetchPriceHistory(asset, blockchain, timeRange) {
  const now = new Date();
  const normalizedTime = normalizeTimeToRangeStart(now, timeRange);
  const cacheKey = `wallet:fetchPriceHistory:${blockchain}:${asset}:${timeRange}:${normalizedTime}`;

  let data = await memcache.get(cacheKey);

  if (data) {
    const cachedData = JSON.parse(data.value);
    // Cache hit, return the cached data
    return cachedData;
  } else {
    // Cache miss, fetch from API
    return await fetchAndCache({ from: normalizedTime, range: timeRange });
  }

  async function fetchAndCache({ from, range = "1d" }) {
    let normalizedTimeInMs;
    const now = new Date();
    switch (range) {
      case "1h":
        now.setHours(now.getHours() - 1);
        normalizedTimeInMs = now.getTime();
        break;
      case "1d":
        now.setDate(now.getDate() - 1);
        normalizedTimeInMs = now.getTime();
        break;
      case "3d":
        now.setDate(now.getDate() - 3);
        normalizedTimeInMs = now.getTime();
        break;
      case "1w":
        now.setDate(now.getDate() - 7);
        normalizedTimeInMs = now.getTime();
        break;
      case "7d":
        now.setDate(now.getDate() - 7);
        normalizedTimeInMs = now.getTime();
        break;
      case "1m":
        now.setDate(1); // Set to the first day of the current month
        now.setHours(0, 0, 0, 0); // Reset hours, minutes, seconds, and milliseconds to 0
        normalizedTimeInMs = now.getTime();
        break;
      // Add more cases as needed
      default:
        normalizedTimeInMs = now.getTime();
    }

    try {
      const queryParams = new URLSearchParams({
        asset,
        blockchain,
        from: normalizedTimeInMs,
      }).toString();

      const response = await axios.get(
        `https://api.mobula.io/api/1/market/history?${queryParams}`,
        {
          headers: {
            Authorization: process.env.MOBULA_API_KEY,
          },
        }
      );
      const jsonData = response.data;
      jsonData.timestamp = new Date().toISOString(); // Add timestamp to data
      // Cache the result for future requests, adjust TTL as needed
      await memcache.set(
        cacheKey,
        JSON.stringify(jsonData.data || {}),
        { lifetime: calculateTTL(range) } // Directly pass the TTL value
      );
      return jsonData.data;
    } catch (error) {
      console.error("Failed to fetch and cache:", error);
      throw error;
    }
  }
}

async function fetchAssetMetadata(network, address) {
  const cacheKey = `wallet:fetchAssetMetadata:${network}:${address}`;
  try {
    let data = await memcache.get(cacheKey);
    if (data) {
      return JSON.parse(data.value);
    } else {
      const queryParams = new URLSearchParams({ asset: address });
      if (network) queryParams.append("blockchain", network);
      const response = await axios.get(
        `https://api.mobula.io/api/1/metadata?${queryParams.toString()}`,
        {
          headers: {
            Authorization: process.env.MOBULA_API_KEY,
          },
        }
      );
      const metadata = response.data;

      await memcache.set(cacheKey, JSON.stringify(metadata?.data || {}), {
        lifetime: 60 * 60,
      }); // Cache for 1 day
      return metadata?.data;
    }
  } catch (error) {
    console.error("Failed to fetch and cache metadata:", error);
    throw error;
  }
}

const oneEthToUsd = () => {
  const marketplaceService = new MarketplaceService();
  return marketplaceService.ethToUsd(1);
};

const weiToUsd = (wei, oneEthToUsd) => {
  try {
    return ethers.utils.formatEther(
      ethers.BigNumber.from(wei || "0").mul(oneEthToUsd)
    );
  } catch (error) {
    console.error("Failed to format wei to usd:", error);
    return "0.00";
  }
};

const formatWeiToUsd = (wei, oneEthToUsd) => {
  const usdFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  try {
    return usdFormatter.format(
      ethers.utils.formatEther(
        ethers.BigNumber.from(wei || "0").mul(oneEthToUsd)
      )
    );
  } catch (error) {
    console.error("Failed to format wei to usd:", error);
    return "0.00";
  }
};

const formatEth = (wei) => {
  return ethers.utils.formatEther(ethers.BigNumber.from(wei || "0"));
};

const DEFAULT_NETWORKS = [
  Network.ETH_MAINNET,
  Network.OPT_MAINNET,
  Network.BASE_MAINNET,
  Network.MATIC_MAINNET,
];

const DEFAULT_CURSOR = null;

const DEFAULT_CURSORS = [
  DEFAULT_CURSOR,
  DEFAULT_CURSOR,
  DEFAULT_CURSOR,
  DEFAULT_CURSOR,
];

const DEFAULT_LIMIT = 100;
const DEFAULT_NFT_LIMIT = 100;

const SKIP_CURSOR = "skip";

const DEFAULT_FILTER_NO_SYMBOL = true;

module.exports = {
  getAccountAssets,
  getOnchainTokens,
  getOnchainTransactions,
  getOnchainNFTs,
  DEFAULT_NETWORKS,
  DEFAULT_LIMIT,
  DEFAULT_CURSOR,
  DEFAULT_CURSORS,
  SKIP_CURSOR,
  DEFAULT_FILTER_NO_SYMBOL,
  fetchPriceHistory,
  fetchAssetMetadata,
  oneEthToUsd,
  formatWeiToUsd,
  formatEth,
  weiToUsd,
};
