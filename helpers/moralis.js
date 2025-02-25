const Moralis = require("moralis").default;
const { ethers } = require("ethers");
const { memcache, getHash } = require("../connectmemcache");
const { BASE_DEX_CONTRACTS_LOWERCASE } = require("./base-dex-contracts");

const NETWORK = {
  ETH: {
    moralisChain: "eth",
    chainId: "0x1",
    dbChain: "ETH",
  },
  BASE: {
    moralisChain: "base",
    chainId: "0x2105",
    dbChain: "BASE",
  },
  OP: {
    moralisChain: "optimism",
    chainId: "0xa",
    dbChain: "OP",
  },
};

// https://etherscan.io/address/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2
const WETH_CONTRACT = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

// Initialize Moralis
const initMoralis = async () => {
  if (!Moralis.Core.isStarted) {
    await Moralis.start({
      apiKey: process.env.MORALIS_API_KEY,
    });
  }
};

// Cache wrapper for Moralis calls
const withCache = async (key, ttl, fetchFn) => {
  const cacheKey = getHash(key);
  const cached = await memcache.get(cacheKey);

  if (cached) {
    return JSON.parse(cached.value);
  }

  const result = await fetchFn();
  await memcache.set(cacheKey, JSON.stringify(result), { lifetime: ttl });
  return result;
};

// Add this helper at the top to standardize chain ID format
const formatChainId = (chainId) => {
  // If chainId is already in hex format (starts with '0x'), return as is
  if (typeof chainId === "string" && chainId.startsWith("0x")) {
    return chainId;
  }
  // Convert decimal string or number to hex
  return "0x" + Number(chainId).toString(16);
};

// Create a helper function to build the PnL lookup map
const buildPnlLookupMap = (pnlHistory) => {
  if (!pnlHistory) return new Map();
  return new Map(
    pnlHistory.map((pnl) => [pnl.token_address.toLowerCase(), pnl])
  );
};

// Update decorateTransactionWithPnlHistory to work with raw data
const decorateTransactionWithPnlHistory = (transactions, pnlHistory) => {
  if (!pnlHistory || !transactions) return transactions;

  const pnlLookup = buildPnlLookupMap(pnlHistory);

  return transactions.map((tx) => {
    if (tx.category === "token swap" && tx.summary) {
      const erc20Transfer = tx.erc20Transfers?.[0];
      if (!erc20Transfer) return tx;

      const tokenAddress = erc20Transfer.address?.toLowerCase();
      if (!tokenAddress) return tx;

      const tokenPnl = pnlLookup.get(tokenAddress);

      if (tokenPnl) {
        const isSell =
          tx.summary?.includes(" for ") &&
          tx.summary?.split(" for ")[1].includes("ETH");

        return {
          ...tx,
          total_pnl: tokenPnl.realized_profit_usd,
          swap_pnl:
            parseFloat(erc20Transfer.value_formatted) *
            (isSell
              ? tokenPnl.avg_sell_price_usd - tokenPnl.avg_buy_price_usd
              : tokenPnl.avg_buy_price_usd - tokenPnl.avg_sell_price_usd),
          avg_buy_price: tokenPnl.avg_buy_price_usd,
          avg_sell_price: tokenPnl.avg_sell_price_usd,
        };
      }
    }
    return tx;
  });
};

// Add this new function after decorateTransactionWithPnlHistory
const decorateTransfersWithPnlHistory = (transfers, pnlHistory) => {
  if (!pnlHistory || !transfers) return transfers;

  const pnlLookup = buildPnlLookupMap(pnlHistory);

  return transfers.map((cleanedTransfer) => {
    const tokenAddress = cleanedTransfer.address?.toLowerCase();
    if (!tokenAddress) return cleanedTransfer;

    const tokenPnl = pnlLookup.get(tokenAddress);

    if (tokenPnl) {
      return {
        ...cleanedTransfer,
        total_pnl: tokenPnl.realized_profit_usd,
        transfer_pnl:
          parseFloat(cleanedTransfer.tokenAmount) *
          (cleanedTransfer.isSell
            ? tokenPnl.avg_sell_price_usd - tokenPnl.avg_buy_price_usd
            : tokenPnl.avg_buy_price_usd - tokenPnl.avg_sell_price_usd),
        avg_buy_price: tokenPnl.avg_buy_price_usd,
        avg_sell_price: tokenPnl.avg_sell_price_usd,
      };
    }
    return cleanedTransfer;
  });
};

// Add this new function after decorateTransfersWithPnlHistory
const cleanTransaction = (tx, ownerAddress) => {
  if (!tx) return null;

  const fromAddressLower = tx.from_address?.toLowerCase();
  const toAddressLower = tx.to_address?.toLowerCase();
  const addressZero = ethers.constants.AddressZero.toLowerCase();

  const fromIsDex =
    BASE_DEX_CONTRACTS_LOWERCASE[fromAddressLower] ||
    fromAddressLower === addressZero;
  const toIsDex =
    BASE_DEX_CONTRACTS_LOWERCASE[toAddressLower] ||
    toAddressLower === addressZero;
  const isBuy = fromIsDex;
  const isSell = toIsDex;
  const isAirdrop =
    ownerAddress && tx.from_address !== ownerAddress.toLowerCase();

  return {
    // Keep original fields for backward compatibility
    ...tx,
    // Standard fields that match token.js format
    timestamp: tx.block_timestamp,
    from: tx.from_address,
    to: tx.to_address,
    tokenAmount: tx.value_decimal,
    valueSymbol: tx.token_symbol,
    txHash: tx.transaction_hash,
    hash: tx.transaction_hash, // Include both for compatibility
    address: tx.address,
    blockNumber: tx.block_number,
    logIndex: tx.log_index,

    // Entity information
    fromEntity: {
      name: tx.from_address_entity,
      logo: tx.from_address_entity_logo,
      label: tx.from_address_label,
    },
    toEntity: {
      name: tx.to_address_entity,
      logo: tx.to_address_entity_logo,
      label: tx.to_address_label,
    },

    // Token information
    token: {
      name: tx.token_name,
      symbol: tx.token_symbol,
      logo: tx.token_logo,
      decimals: tx.token_decimals,
      address: tx.address,
      possible_spam: tx.possible_spam,
    },

    // Transaction type
    type: isSell ? "Sell" : isBuy ? "Buy" : isAirdrop ? "Airdrop" : "Swap",
    isSell,
    isBuy,
  };
};

// Update getWalletHistory to return raw data
const getWalletHistory = async (
  address,
  chain,
  limit,
  cursor,
  {
    nftMetadata = false,
    includeInternalTransactions = false,
    categoryFilter = null,
  } = {}
) => {
  await initMoralis();
  return await withCache(
    `moralis:history:${address}:${limit}:${cursor || "initial"}:${
      categoryFilter || "all"
    }`,
    30,
    async () => {
      const options = { address, chain, limit };
      if (cursor) options.cursor = cursor;
      if (nftMetadata) options.nftMetadata = nftMetadata;
      if (includeInternalTransactions)
        options.includeInternalTransactions = includeInternalTransactions;

      const response = await Moralis.EvmApi.wallets.getWalletHistory(options);
      const rawResponse = {
        ...response.toJSON(),
        result: response.result.map((tx) => ({
          ...tx.toJSON(),
          erc20Transfers: tx.erc20Transfers?.map((transfer) =>
            transfer.toJSON()
          ),
        })),
      };

      // Apply category filtering if specified
      if (categoryFilter && rawResponse.result) {
        return {
          ...rawResponse,
          result: rawResponse.result.filter(
            (tx) => tx.category === categoryFilter
          ),
        };
      }

      return rawResponse;
    }
  );
};

const getNativeBalance = async (address, chain) => {
  await initMoralis();
  return withCache(`moralis:balance:${address}`, 30, async () => {
    const response = await Moralis.EvmApi.balance.getNativeBalance({
      address,
      chain,
    });
    return response.toJSON();
  });
};

// Update decorateTokenWithPnlHistory to use correct field names
const decorateTokenWithPnlHistory = (tokens, pnlHistory) => {
  if (!pnlHistory || !tokens) return tokens;

  // Build lookup map once
  const pnlLookup = buildPnlLookupMap(pnlHistory);

  return tokens.map((token) => {
    const tokenAddress = token.token_address?.toLowerCase();
    if (!tokenAddress) return token;

    // O(1) lookup instead of O(n)
    const tokenPnl = pnlLookup.get(tokenAddress);

    if (tokenPnl) {
      // Parse values safely using the correct field names
      const tokenAmount = parseFloat(token.balance_formatted) || 0;
      const currentPrice = parseFloat(token.usd_price) || 0;
      const avgBuyPrice = parseFloat(tokenPnl.avg_buy_price_usd) || 0;

      // Calculate unrealized PnL only if we have valid numbers
      const unrealizedPnl =
        tokenAmount && currentPrice && avgBuyPrice
          ? tokenAmount * (currentPrice - avgBuyPrice)
          : 0;

      return {
        ...token,
        ...tokenPnl,
        total_pnl: tokenPnl.realized_profit_usd,
        avg_buy_price: tokenPnl.avg_buy_price_usd,
        avg_sell_price: tokenPnl.avg_sell_price_usd,
        unrealized_pnl: unrealizedPnl,
        // Add these fields for debugging
        // debug_amount: tokenAmount,
        // debug_current_price: currentPrice,
        // debug_avg_buy_price: avgBuyPrice,
      };
    }
    return token;
  });
};

// Update getTokenBalances to return raw data
const getTokenBalances = async (address, chain, ignoreSmallValues = true) => {
  await initMoralis();
  const formattedChain = formatChainId(chain);
  return withCache(
    `moralis:tokens:${address}:${ignoreSmallValues}`,
    30,
    async () => {
      try {
        const response =
          await Moralis.EvmApi.wallets.getWalletTokenBalancesPrice({
            address,
            chain: formattedChain,
          });

        let holdings =
          response.result.map((token) => {
            const result = {
              ...token.toJSON(),
            };

            // Only calculate market cap if usdPrice exists
            if (token.usdPrice) {
              // Convert totalSupply to decimal format using token decimals
              const totalSupplyDecimal = ethers.utils.formatUnits(
                token.totalSupply || "0",
                token.decimals || 18
              );
              // Calculate market cap
              result.market_cap_usd =
                token.usdPrice * parseFloat(totalSupplyDecimal);
            } else {
              result.market_cap_usd = null;
            }

            return result;
          }) || [];

        // Filter small values if requested
        if (ignoreSmallValues) {
          holdings = holdings.filter(
            (token) => parseFloat(token.usd_value) >= 1
          );
        }

        // Sort by USD value descending
        holdings.sort((a, b) => b.usd_value - a.usd_value);

        return holdings;
      } catch (error) {
        console.error(
          "Error fetching token balances:",
          error.message,
          error.stack
        );
        return [];
      }
    }
  );
};

const getWalletNetWorth = async (address) => {
  await initMoralis();

  return withCache(`moralis:networth:${address}`, 30, async () => {
    try {
      const response = await Moralis.EvmApi.wallets.getWalletNetWorth({
        address,
        excludeSpam: true,
        excludeUnverifiedContracts: true,
      });

      return response.raw;
    } catch (error) {
      console.error(
        "Error fetching wallet net worth:",
        error.message,
        error.stack
      );
      return { total_usd: 0 };
    }
  });
};

const getPnLHistory = async (address, chain, days = "all") => {
  await initMoralis();
  const formattedChain = formatChainId(chain);
  return withCache(`moralis:pnl:${address}:${days}`, 60 * 60, async () => {
    try {
      const response = await Moralis.EvmApi.wallets.getWalletProfitability({
        address,
        chain: formattedChain,
        days,
      });

      return response.raw.result || [];
    } catch (error) {
      console.error("Error fetching PnL history:", error.message, error.stack);
      return [];
    }
  });
};

const getWalletTokenStats = async (address, chain, days = "7") => {
  await initMoralis();
  const formattedChain = formatChainId(chain);
  return withCache(
    `moralis:tokenstats:${address}:${days}`,
    60 * 60,
    async () => {
      try {
        const summary =
          await Moralis.EvmApi.wallets.getWalletProfitabilitySummary({
            address,
            chain: formattedChain,
            days,
          });

        return {
          summary: summary.raw,
        };
      } catch (error) {
        console.error(
          "Error fetching wallet token stats:",
          error.message,
          error.stack
        );
        return {
          summary: {
            total_realized_profit_usd: "0",
            total_realized_profit_percentage: "0",
            total_trade_volume: "0",
            total_count_of_trades: "0",
          },
        };
      }
    }
  );
};

// Add this new function after initMoralis and before other functions
const getMultipleTokenPrices = async (chain, tokens) => {
  await initMoralis();
  const formattedChain = formatChainId(chain);

  // Create cache key from chain and sorted token addresses
  const tokensRes = tokens
    .filter((t) => t.tokenAddress)
    .map((t) => {
      const res = {
        tokenAddress: t.tokenAddress,
      };
      if (t.exchange) {
        res.exchange = res.exchange.toLowerCase();
      }
      if (t.toBlock) {
        res.toBlock = t.toBlock;
      }
      return res;
    });

  const cachedTokenKey = tokensRes
    .sort((a, b) => a.tokenAddress.localeCompare(b.tokenAddress))
    .map((t) => `${t.tokenAddress}:${t.exchange}:${t.toBlock}`)
    .join(",");

  const cacheKey = `moralis:prices:${formattedChain}:${cachedTokenKey}`;

  return withCache(cacheKey, 30, async () => {
    try {
      const response = await Moralis.EvmApi.token.getMultipleTokenPrices(
        {
          chain: formattedChain,
          include: "percent_change",
        },
        {
          tokens: tokensRes,
        }
      );

      return response.raw;
    } catch (error) {
      console.error("Error fetching token prices:", error.message, error.stack);
      return [];
    }
  });
};

// Add this new function after getMultipleTokenPrices
const getTokenPrice = async (chain, address) => {
  await initMoralis();
  const formattedChain = formatChainId(chain);

  return withCache(
    `moralis:price:${formattedChain}:${address}`,
    30,
    async () => {
      try {
        const response = await Moralis.EvmApi.token.getTokenPrice({
          chain: formattedChain,
          include: "percent_change",
          address: address,
        });

        return response.raw;
      } catch (error) {
        console.error(
          "Error fetching token price:",
          error.message,
          error.stack
        );
        return null;
      }
    }
  );
};

const getTokenMetadata = async (chain, addresses) => {
  await initMoralis();
  const formattedChain = formatChainId(chain);

  // check if one of the addresses is null
  if (addresses.some((address) => !address)) {
    throw new Error("Null address is not allowed!");
  }

  if (addresses.length === 0) {
    return [];
  }

  // Sort addresses to ensure consistent cache key
  const sortedAddresses = [...addresses].sort().join(",");
  const cacheKey = `moralis:metadata:${formattedChain}:${sortedAddresses}`;

  // 5 minutes
  return withCache(cacheKey, 5 * 60, async () => {
    try {
      const response = await Moralis.EvmApi.token.getTokenMetadata({
        chain: formattedChain,
        addresses: addresses,
      });

      return response.raw;
    } catch (error) {
      console.error(
        "Error fetching token metadata:",
        error.message,
        error.stack
      );
      return [];
    }
  });
};

const getTokenOwners = async (
  chain,
  tokenAddress,
  { limit = 100, cursor = null } = {}
) => {
  await initMoralis();
  const formattedChain = formatChainId(chain);

  return withCache(
    `moralis:token:owners:${formattedChain}:${tokenAddress}:${limit}:${
      cursor || "initial"
    }`,
    30,
    async () => {
      try {
        const options = {
          chain: formattedChain,
          tokenAddress,
          limit,
          order: "DESC",
        };

        if (cursor) {
          options.cursor = cursor;
        }

        const response = await Moralis.EvmApi.token.getTokenOwners(options);

        return response.toJSON();
      } catch (error) {
        console.error(
          "Error fetching token owners:",
          error.message,
          error.stack
        );
        return [];
      }
    }
  );
};

const getTokenTransfers = async (
  chain,
  tokenAddress,
  { limit = 100, cursor = null } = {}
) => {
  await initMoralis();
  const formattedChain = formatChainId(chain);

  return withCache(
    `moralis:token:transfers:${formattedChain}:${tokenAddress}:${limit}:${
      cursor || "initial"
    }`,
    30,
    async () => {
      try {
        const options = {
          chain: formattedChain,
          address: tokenAddress,
          limit,
          order: "DESC",
        };

        if (cursor) {
          options.cursor = cursor;
        }

        const response = await Moralis.EvmApi.token.getTokenTransfers(options);
        return response.raw;
      } catch (error) {
        console.error(
          "Error fetching token transfers:",
          error.message,
          error.stack
        );
        return [];
      }
    }
  );
};

const getWalletTokenTransfers = async (
  chain,
  walletAddress,
  { limit = 100, cursor = null } = {}
) => {
  await initMoralis();
  const formattedChain = formatChainId(chain);

  return withCache(
    `moralis:wallet:token:transfers:${formattedChain}:${walletAddress}:${limit}:${
      cursor || "initial"
    }`,
    30,
    async () => {
      try {
        const options = {
          chain: formattedChain,
          address: walletAddress,
          limit,
          order: "DESC",
        };

        if (cursor) {
          options.cursor = cursor;
        }

        const response = await Moralis.EvmApi.token.getWalletTokenTransfers(
          options
        );
        return response.raw;
      } catch (error) {
        console.error(
          "Error fetching wallet token transfers:",
          error.message,
          error.stack
        );
        return { result: [], cursor: null };
      }
    }
  );
};

// Update decorateTransactionPrice to handle BigNumber calculations better
const decorateTransactionPrice = async (transactions, chain) => {
  if (!transactions || !transactions.length) return transactions;

  const tokenAddresses = transactions
    .map((t) => ({
      tokenAddress: t.token?.address || t.address,
      toBlock: t.blockNumber,
    }))
    .filter((t) => t.tokenAddress);

  if (!tokenAddresses.length) return transactions;

  const tokenPrices = await getMultipleTokenPrices(chain, tokenAddresses);
  const priceMap = new Map(
    tokenPrices.map((price) => [price.tokenAddress.toLowerCase(), price])
  );

  return transactions.map((tx) => {
    const tokenAddress = tx.token?.address?.toLowerCase();
    if (!tokenAddress) return tx;

    const price = priceMap.get(tokenAddress);
    if (!price) return tx;

    const tokenDecimals = parseInt(tx.token.decimals || price.tokenDecimals);

    // Convert token amount to BigNumber using the raw value
    const rawAmount = tx.value || tx.tokenAmount;
    const tokenAmountBN = ethers.BigNumber.from(
      rawAmount.includes(".") // If it's a decimal string
        ? ethers.utils.parseUnits(rawAmount, tokenDecimals).toString()
        : rawAmount
    );

    const usdPrice = parseFloat(price.usdPrice || "0");
    const usdValue =
      parseFloat(ethers.utils.formatUnits(tokenAmountBN, tokenDecimals)) *
      usdPrice;

    // Handle native price calculations
    const nativePrice = price.nativePrice?.value
      ? ethers.BigNumber.from(price.nativePrice.value)
      : ethers.BigNumber.from(0);
    const nativeDecimals = price.nativePrice?.decimals || 18;

    // Calculate native value: (tokenAmount * nativePrice) / (10 ** nativeDecimals)
    const txAmountNative = tokenAmountBN
      .mul(nativePrice)
      .div(ethers.BigNumber.from(10).pow(tokenDecimals));

    const formattedTokenAmount = ethers.utils.formatUnits(
      tokenAmountBN,
      tokenDecimals
    );

    return {
      ...tx,
      price: {
        usd: usdPrice,
        usd_formatted: price.usdPriceFormatted,
        token_decimals: tokenDecimals,
        exchange: price.exchangeName,
        pair_liquidity_usd: price.pairTotalLiquidityUsd,
        percent_change_24h: price["24hrPercentChange"],
        native: price.nativePrice
          ? {
              ...price.nativePrice,
              value: nativePrice.toString(),
            }
          : null,
      },
      value_usd: usdValue,
      value_usd_formatted: usdValue.toFixed(2),
      txAmount: {
        token: formattedTokenAmount,
        token_formatted: parseFloat(formattedTokenAmount).toFixed(4),
        token_raw: tokenAmountBN.toString(),
        usd: usdValue,
        usd_formatted: usdValue.toFixed(2),
        native: txAmountNative.toString(),
        native_formatted: ethers.utils.formatUnits(
          txAmountNative,
          nativeDecimals
        ),
        native_symbol: price.nativePrice?.symbol || "ETH",
      },
    };
  });
};

// Add a batch version for multiple transactions
const decorateTransactionsPrices = async (transactions, chain) => {
  if (!Array.isArray(transactions)) {
    return decorateTransactionPrice([transactions], chain).then(
      (results) => results[0]
    );
  }
  return decorateTransactionPrice(transactions, chain);
};

// Add this new function after decorateTransactionsPrices
const cleanTokenToMoralis = (token) => {
  const balanceBN = ethers.BigNumber.from(
    token.balance.replace(/^0+/, "") || "0"
  );
  const balanceFormatted = ethers.utils.formatEther(balanceBN);
  const usdValue =
    parseFloat(balanceFormatted) * parseFloat(token.pricePerTokenUSD || 0);

  const totalSupplyFormatted = ethers.utils.formatEther(token.totalSupply);
  const percentageOfSupply = (
    (parseFloat(balanceFormatted) / parseFloat(totalSupplyFormatted)) *
    100
  ).toFixed(2);

  return {
    is_fartoken: token.isFartoken,
    token_address: token.tokenAddress.toLowerCase(),
    name: token.name,
    symbol: token.symbol,
    logo: token.metadata?.image || null,
    thumbnail: token.metadata?.image || null,
    decimals: 18, // Bonding curve tokens use 18 decimals
    balance: balanceBN.toString(),
    possible_spam: false,
    verified_contract: true,
    usd_price: parseFloat(token.pricePerTokenUSD || 0),
    // These fields might not be available in the source data
    usd_price_24hr_percent_change: null,
    usd_price_24hr_usd_change: null,
    usd_value_24hr_usd_change: null,
    usd_value: usdValue,
    // Portfolio percentage will need to be calculated at a higher level
    portfolio_percentage: null,
    balance_formatted: balanceFormatted,
    native_token: false,
    total_supply: token.totalSupply,
    total_supply_formatted: totalSupplyFormatted,
    percentage_relative_to_total_supply: percentageOfSupply,
  };
};

module.exports = {
  initMoralis,
  getMultipleTokenPrices,
  getTokenPrice,
  getWalletHistory,
  getNativeBalance,
  getTokenBalances,
  getWalletNetWorth,
  getPnLHistory,
  getWalletTokenStats,
  decorateTransactionWithPnlHistory,
  decorateTokenWithPnlHistory,
  getTokenMetadata,
  NETWORK,
  WETH_CONTRACT,
  getTokenOwners,
  getTokenTransfers,
  getWalletTokenTransfers,
  decorateTransfersWithPnlHistory,
  cleanTransaction,
  decorateTransactionPrice,
  decorateTransactionsPrices,
  cleanTokenToMoralis,
};
