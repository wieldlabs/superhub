const ethers = require("ethers");
const axios = require("axios");
const Sentry = require("@sentry/node");
const { getProvider } = require("../helpers/alchemy-provider");
const { config } = require("../helpers/marketplace");
const {
  validateAndConvertAddress,
} = require("../helpers/validate-and-convert-address");
const { memcache } = require("../connectmemcache");
const {
  Listings,
  ListingLogs,
  Fids,
  Offers,
  Appraisals,
} = require("../models/farcaster");
const { CastHandle } = require("../models/CastHandle");
const {
  getFarcasterUserByFid,
  searchFarcasterUserByMatch,
  searchCastHandleByMatch,
} = require("../helpers/farcaster");
const { Service: _CacheService } = require("./cache/CacheService");
const { WETH_CONTRACT, NETWORK, getTokenPrice } = require("../helpers/moralis");

class MarketplaceService {
  constructor() {
    const alchemyProvider = getProvider({
      network: config().NODE_NETWORK,
      node: config().NODE_URL,
    });

    const marketplace = new ethers.Contract(
      config().FID_MARKETPLACE_V1_ADDRESS,
      config().FID_MARKETPLACE_ABI,
      alchemyProvider
    );

    const idRegistry = new ethers.Contract(
      config().ID_REGISTRY_ADDRESS,
      config().ID_REGISTRY_ABI,
      alchemyProvider
    );

    this.marketplace = marketplace;
    this.idRegistry = idRegistry;
    this.alchemyProvider = alchemyProvider;

    this.usdFormatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  _getFidCollectionQuery(collection) {
    if (!collection) return null;
    if (collection === "1k") {
      return {
        $lte: 1000,
        $gte: 0,
      };
    } else if (collection === "5k") {
      return {
        $lte: 5000,
        $gt: 1000,
      };
    } else if (collection === "10k") {
      return {
        $lte: 10000,
        $gt: 5000,
      };
    } else if (collection === "og") {
      return {
        $lte: 20000,
        $gte: 0,
      };
    } else if (collection === "castHandle") {
      return -1;
    } else {
      return null;
    }
  }

  // This method takes eth in full integers (aka 1.5 doesn't work), then you divide by how many decimals you want.
  async ethToUsd(eth) {
    if (!eth) return "0";
    try {
      const cachedEth = await memcache.get("MarketplaceService_ethToUsd");
      if (cachedEth) {
        return ethers.BigNumber.from(cachedEth.value).mul(eth).toString();
      }
      const ethPrice = (await getTokenPrice(NETWORK.ETH.chainId, WETH_CONTRACT))
        ?.usdPrice;

      if (!ethPrice || parseInt(ethPrice) === 0) {
        return "0";
      }
      await memcache.set(
        "MarketplaceService_ethToUsd",
        parseInt(ethPrice).toString(),
        {
          lifetime: 5 * 60, // 5 mins
        }
      );

      return ethers.BigNumber.from(parseInt(ethPrice)).mul(eth).toString();
    } catch (e) {
      console.error(e);
      Sentry.captureException(e);
      return "0";
    }
  }

  // pad number with zeros to 32 bytes for easy sorting in mongodb
  _padWithZeros(numberString) {
    const maxLength = 32;
    while (numberString.length < maxLength) {
      numberString = "0" + numberString;
    }
    return numberString;
  }

  async getBestOffer({ fid }) {
    let offer;
    const data = await memcache.get(`getBestOffer:${fid}`);
    if (data) {
      offer = new Offers(JSON.parse(data.value));
    }

    if (!offer) {
      offer = await Offers.findOne({
        canceledAt: null,
        fid,
      }).sort({ amount: -1 });

      if (offer) {
        await memcache.set(`getBestOffer:${fid}`, JSON.stringify(offer));
      }
    }
    if (!offer) return null;

    const [user, usdWei] = await Promise.all([
      this.fetchUserData(fid),
      this.ethToUsd(offer.amount),
    ]);

    const usd = this.usdFormatter.format(ethers.utils.formatEther(usdWei));

    return {
      ...JSON.parse(JSON.stringify(offer)),
      usd,
      user,
    };
  }

  async getListing({ fid, tokenId, chainId }) {
    let listing;
    const cacheKey = `Listing:${fid}${tokenId ? `:${tokenId}` : ""}${
      chainId ? `:${chainId}` : ""
    }`;
    const data = await memcache.get(cacheKey);
    if (data) {
      listing = new Listings(JSON.parse(data.value));
    }
    if (!listing) {
      const query = {
        fid,
        canceledAt: null,
        deadline: { $gt: Math.floor(Date.now() / 1000) },
      };
      if (tokenId) {
        // token id is in big number string format
        if (tokenId.toString().startsWith("0x")) {
          try {
            const bigIntValue = ethers.BigNumber.from(tokenId);
            tokenId = bigIntValue.toString();
          } catch (error) {
            // do nothing
          }
        }

        query.tokenId = tokenId;
      }
      if (chainId) query.chainId = chainId;

      listing = await Listings.findOne(query);
      listing = listing ? listing._doc : null;
      if (listing) {
        await memcache.set(cacheKey, JSON.stringify(listing));
      }
    }
    if (!listing) return null;

    const [user, usdWei] = await Promise.all([
      this.fetchUserData(fid),
      this.ethToUsd(listing.minFee),
    ]);

    const usd = this.usdFormatter.format(ethers.utils.formatEther(usdWei));

    return {
      ...JSON.parse(JSON.stringify(listing)),
      usd,
      user,
    };
  }

  async fetchCastHandle(tokenId, chainId) {
    // Convert tokenId to 0x format if it's a BigInt string
    if (tokenId && !tokenId.toString().startsWith("0x")) {
      try {
        // Parse the BigInt string and convert to hexadecimal
        const bigIntValue = ethers.BigNumber.from(tokenId);
        tokenId = bigIntValue.toHexString();
      } catch (error) {
        console.error("Error converting tokenId to 0x format:", error);
        // If conversion fails, keep the original tokenId
      }
    }

    return await CastHandle.findOne({
      tokenId: CastHandle.normalizeTokenId(tokenId),
      chainId,
    });
  }

  async fetchUserData(fid, tokenId, chainId) {
    if (fid == -1) {
      return await this.fetchCastHandle(tokenId, chainId);
    }
    return await getFarcasterUserByFid(fid);
  }

  async fetchListing(fid, tokenId, chainId) {
    return await this.getListing({ fid, tokenId, chainId });
  }

  async fetchDataForFids(fidsArr) {
    return await Promise.all(
      fidsArr.map(async (fid) => {
        const [user, listing, bestOffer] = await Promise.all([
          this.fetchUserData(fid),
          this.fetchListing(fid),
          // this.getBestOffer({ fid }),
        ]);
        return {
          fid,
          user,
          listing,
          bestOffer,
        };
      })
    );
  }

  async filterByUserProfile(data) {
    return data.filter((item) => item.user);
  }

  async getOnlyBuyNowListings({
    sort = "fid",
    limit = 20,
    cursor = "",
    filters = {},
  }) {
    let listings;
    const hasFilters = Object.keys(filters).length > 0;

    const data = await memcache.get(
      `MarketplaceService:getOnlyBuyNowListings:${sort}:${limit}:${cursor}${
        hasFilters ? `:${JSON.stringify(filters)}` : ""
      }`
    );

    if (data) {
      listings = JSON.parse(data.value).map((listing) => new Listings(listing));
    }
    const [_offset, lastId] = cursor ? cursor.split("-") : ["0", null];
    const offset = parseInt(_offset);

    if (!listings) {
      const query = {
        // fid:
        //   sort === "fid"
        //     ? { $gt: offset || 0 }
        //     : { $lt: offset || Number.MAX_SAFE_INTEGER },
        fid: { $gte: 0 },
        id:
          sort[0] !== "-"
            ? { $lt: lastId || Number.MAX_SAFE_INTEGER }
            : { $gt: lastId || 0 },
        deadline: { $gt: Math.floor(Date.now() / 1000) },
        canceledAt: null,
      };
      if (filters.collection) {
        const filteredFid = this._getFidCollectionQuery(filters.collection);
        if (filteredFid) {
          query.fid = filteredFid;
        }
      }
      if (filters.address) {
        query.ownerAddress = filters.address;
      }

      listings = await Listings.find(query)
        .limit(limit)
        .skip(offset)
        .sort(sort + " _id");
      if (cursor) {
        await memcache.set(
          `MarketplaceService:getOnlyBuyNowListings:${sort}:${limit}:${cursor}${
            hasFilters ? `:${JSON.stringify(filters)}` : ""
          }`,
          JSON.stringify(listings)
        );
      } else {
        await memcache.set(
          `MarketplaceService:getOnlyBuyNowListings:${sort}:${limit}:${cursor}${
            hasFilters ? `:${JSON.stringify(filters)}` : ""
          }`,
          JSON.stringify(listings),
          {
            lifetime: 60, // 60s
          }
        );
      }
    }

    let extraData = await Promise.all(
      listings.map(async (listing) => {
        const [user, usdWei] = await Promise.all([
          this.fetchUserData(listing.fid, listing.tokenId, listing.chainId),
          this.ethToUsd(listing.minFee),
        ]);

        const usd = this.usdFormatter.format(ethers.utils.formatEther(usdWei));
        return {
          fid: listing.fid,
          user,
          listing: {
            ...listing._doc,
            usd,
            user,
          },
        };
      })
    );

    let next = null;
    if (extraData.length >= limit) {
      const lastId = extraData[extraData.length - 1].listing._id;
      next = `${offset + extraData.length}-${lastId.toString()}`;
    }

    return [extraData.slice(0, limit), next];
  }
  async latestFid() {
    let count;
    const data = await memcache.get(`MarketplaceService:latestFid`);
    if (data) {
      count = data.value;
    }
    if (!count) {
      count = await Fids.estimatedDocumentCount();
      await memcache.set(`MarketplaceService:latestFid`, count, {
        lifetime: 60 * 60, // 1 hour
      });
    }
    return count;
  }

  async searchListings({
    sort = "fid",
    limit = 20,
    cursor = "",
    filters = {},
  }) {
    // @TODO add sort and cursor
    const usersPromise = searchFarcasterUserByMatch(
      filters.query,
      limit,
      "value",
      false
    );

    const promises = [usersPromise];

    if (config().ENABLE_NFT_MARKETPLACE) {
      promises.push(searchCastHandleByMatch(filters.query, limit, "value"));
    }
    const [fidUsers, castHandles = []] = await Promise.all(promises);
    const users = [...fidUsers, ...castHandles];

    const extraData = await Promise.all(
      users.map(async (user) => {
        let listing = null;
        if (user.handle) {
          listing = await this.fetchListing(
            -1,
            user.tokenId,
            user.chain === "ETH" ? 1 : 10
          );
        } else {
          listing = await this.fetchListing(user.fid);
        }
        return {
          fid: user.fid,
          user,
          listing,
        };
      })
    );

    return [extraData, null];
  }

  async getListingsDsc({
    sort = "fid",
    limit = 20,
    cursor = "",
    filters = {},
  }) {
    const [offset, lastId] = cursor
      ? cursor.split("-")
      : [await this.latestFid(), null];
    let startsAt = parseInt(offset);
    let endAt = startsAt - parseInt(limit);

    let fidsArr = [];
    for (let i = startsAt; i > endAt; i--) {
      fidsArr.push(i.toString());
    }

    let extraData = await this.fetchDataForFids(fidsArr);

    let next = null;
    if (extraData.length >= limit) {
      const lastFid = ethers.BigNumber.from(
        extraData[extraData.length - 1].fid
      );
      next = `${lastFid.sub(1).toString()}-${lastFid.sub(1).toString()}`;
    }

    return [extraData.slice(0, limit), next];
  }

  async getListings({ sort = "fid", limit = 20, cursor = "", filters = {} }) {
    if (filters.query) {
      // filter by searching users
      return await this.searchListings({
        sort,
        limit,
        cursor,
        filters,
      });
    } else if (
      sort === "minFee" ||
      sort === "-minFee" ||
      sort === "updatedAt" ||
      sort === "-updatedAt" ||
      filters.onlyListing
    ) {
      return await this.getOnlyBuyNowListings({
        sort,
        limit,
        cursor,
        filters,
      });
      // filters: all, collection: all cast handles
    } else if (filters.collection === "castHandle") {
      // implement here
      return await this.getCastHandles({
        sort,
        limit,
        cursor,
        filters,
      });
    } else if (sort === "-fid") {
      return await this.getListingsDsc({
        sort,
        limit,
        cursor,
        filters,
      });
    }
    const [offset, lastId] = cursor ? cursor.split("-") : ["1", null];
    let startsAt = parseInt(offset);
    let endAt = startsAt + parseInt(limit);

    let fidsArr = [];
    for (let i = startsAt; i < endAt; i++) {
      fidsArr.push(i.toString());
    }

    let extraData = await this.fetchDataForFids(fidsArr);

    let next = null;
    if (extraData.length >= limit) {
      const lastFid = ethers.BigNumber.from(
        extraData[extraData.length - 1].fid
      );
      next = `${lastFid.add(1).toString()}-${lastFid.add(1).toString()}`;
    }

    return [extraData.slice(0, limit), next];
  }

  /**
   * Get proxy marketplace address
   * @returns {Promise<string>} - address of owner
   */
  async getProxyAddress({ address, salt }) {
    if (!address || !salt) return null;

    try {
      let proxyAddress;
      const data = await memcache.get(
        `MarketplaceService:getProxyAddress:${address}:${salt}`
      );
      if (data) {
        proxyAddress = JSON.parse(data.value);
      }
      if (proxyAddress) return proxyAddress;
      proxyAddress = await this.marketplace.getAddress(
        validateAndConvertAddress(address),
        salt
      );
      await memcache.set(
        `MarketplaceService:getProxyAddress:${address}:${salt}`,
        JSON.stringify(proxyAddress)
      );
      return proxyAddress;
    } catch (e) {
      Sentry.captureException(e);
      return null;
    }
  }
  async getTransactionArguments({ txHash }) {
    const transaction = await this.alchemyProvider.getTransaction(
      txHash.toString()
    );
    if (!transaction) {
      throw new Error("Transaction not found");
    }
    const eventInterface = new ethers.utils.Interface(
      config().FID_MARKETPLACE_ABI
    );

    const decodedInput = eventInterface.parseTransaction({
      data: transaction.data,
      value: transaction.value,
    });

    return {
      functionName: decodedInput.name,
      args: decodedInput.args,
    };
  }

  async getReceipt({ txHash }) {
    let tries = 0;
    let receipt;

    while (tries < 120) {
      tries += 1;
      await new Promise((r) => setTimeout(r, 1000));

      receipt = await this.alchemyProvider.getTransactionReceipt(
        txHash.toString()
      );
      if (receipt) break;
    }
    if (tries >= 120) throw new Error("Timeout");
    return receipt;
  }

  async getBlockTimestamp(blockNumber) {
    const block = await this.alchemyProvider.getBlock(blockNumber);
    return new Date(block.timestamp * 1000); // Convert to JavaScript Date object
  }

  async cancelListing({ txHash }) {
    if (!txHash) {
      throw new Error("Missing txHash");
    }
    const existing = await ListingLogs.findOne({ txHash });
    if (existing) {
      return await Listings.findOne({ fid: existing.fid });
    }
    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }
    const eventInterface = new ethers.utils.Interface(
      config().FID_MARKETPLACE_ABI
    );
    let updatedListing = null;
    for (let log of receipt.logs) {
      try {
        const parsed = eventInterface.parseLog(log);
        const fid = parsed.args.fid.toNumber();

        const query = {
          fid,
        };

        if (parsed.name === "Canceled") {
          updatedListing = await Listings.findOneAndUpdate(
            query,
            {
              txHash,
              canceledAt: new Date(),
            },
            {
              new: true,
            }
          );

          await ListingLogs.updateOne(
            {
              txHash,
            },
            {
              eventType: "Canceled",
              fid: fid,
              txHash,
            },
            {
              upsert: true,
            }
          );

          await memcache.delete(`Listing:${fid}`, {
            noreply: true,
          });
          break;
        }
      } catch (error) {
        // Log could not be parsed; continue to next log
        throw new Error("Cannot cancel listing, try again later");
      }
    }
    if (!updatedListing) {
      throw new Error("FID not listed");
    }
    return updatedListing;
  }

  async getHighestSale() {
    const s = await memcache.get("MarketplaceService:stats:highestSale");
    if (s) {
      return s.value;
    }
    const highestSale = await ListingLogs.findOne({
      eventType: {
        $in: ["Bought", "OfferApproved"],
      },
    }).sort({ price: -1 });
    if (highestSale) {
      await memcache.set(
        "MarketplaceService:stats:highestSale",
        highestSale.price,
        {
          lifetime: 60, // 60s
        }
      );
      return highestSale.price;
    }
  }

  // THIS DOES NOT WORK YET
  async getTotalVolume() {
    const s = await memcache.get("MarketplaceService:stats:totalVolume");
    if (s) {
      return s.value;
    }
    const totalVolume = await ListingLogs.aggregate([
      {
        $match: {
          eventType: {
            $in: ["Bought", "OfferApproved"],
          },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: "$price",
          },
        },
      },
    ]);

    if (totalVolume.length) {
      await memcache.set(
        "MarketplaceService:stats:totalVolume",
        totalVolume[0].total,
        {
          lifetime: 60, // 60s
        }
      );
      return totalVolume[0].total;
    }
  }

  async getStats() {
    try {
      let stats;

      const data = await memcache.get("MarketplaceService:getStats");
      if (data) {
        stats = JSON.parse(data.value);
      }

      if (!stats) {
        const [
          floorListing,
          highestOffer,
          highestSaleRaw,
          // totalVolumeRaw,
          oneEthToUsd,
          lastFid,
        ] = await Promise.all([
          Listings.findOne({ canceledAt: null }).sort({ minFee: 1 }),
          Offers.findOne({ canceledAt: null }).sort({ amount: -1 }),
          this.getHighestSale(),
          // this.getTotalVolume(),
          this.ethToUsd(1),
          this.latestFid(),
        ]);

        const highestSale = highestSaleRaw || "0";
        // const totalVolume = totalVolumeRaw || "0";

        stats = {
          stats: {
            floor: {
              usd: this.usdFormatter.format(
                ethers.utils.formatEther(
                  ethers.BigNumber.from(floorListing.minFee).mul(oneEthToUsd)
                )
              ),
              wei: floorListing.minFee,
            },
            lastFid: {
              value: `#${lastFid}` || "0",
            },
            highestOffer: {
              usd: this.usdFormatter.format(
                ethers.utils.formatEther(
                  ethers.BigNumber.from(highestOffer?.amount || "0").mul(
                    oneEthToUsd
                  )
                )
              ),
              wei: highestOffer?.amount || "0",
            },
            highestSale: {
              usd: this.usdFormatter.format(
                ethers.utils.formatEther(
                  ethers.BigNumber.from(highestSale).mul(oneEthToUsd)
                )
              ),
              wei: highestSale,
            },
            // totalVolume: {
            //   usd: this.usdFormatter.format(
            //     ethers.utils.formatEther(
            //       ethers.BigNumber.from(totalVolume).mul(oneEthToUsd)
            //     )
            //   ),
            //   wei: totalVolume,
            // },
          },
          success: true,
        };

        await memcache.set(
          "MarketplaceService:getStats",
          JSON.stringify(stats)
        );
      }

      return stats;
    } catch (e) {
      console.error(e);
      Sentry.captureException(e);
      // skip
      return {
        success: false,
        stats: {},
      };
    }
  }

  async computeStats({ txHash }) {
    const receipt = await this.getReceipt({ txHash });
    const eventInterface = new ethers.utils.Interface(
      config().FID_MARKETPLACE_ABI
    );

    for (let log of receipt.logs) {
      try {
        const parsed = eventInterface.parseLog(log);
        if (parsed.name === "Listed") {
          const lastFloorRaw = await memcache.get(
            "MarketplaceService:stats:floor"
          );
          const lastFloor = lastFloorRaw?.value;
          const newFloor = lastFloor
            ? ethers.BigNumber.from(parsed.args.amount).lt(
                ethers.BigNumber.from(lastFloor)
              )
              ? parsed.args.amount.toString()
              : lastFloor
            : parsed.args.amount.toString();

          await memcache.set("MarketplaceService:stats:floor", newFloor);
          break;
        } else if (parsed.name === "Bought") {
          const [highestSaleRaw, totalVolumeRaw] = await Promise.all([
            memcache.get("MarketplaceService:stats:highestSale"),
            memcache.get("MarketplaceService:stats:totalVolume"),
          ]);
          const highestSale = highestSaleRaw?.value;
          const totalVolume = totalVolumeRaw?.value;

          const saleAmount = parsed.args.amount.toString();

          if (
            !highestSale ||
            ethers.BigNumber.from(saleAmount).gt(
              ethers.BigNumber.from(highestSale)
            )
          ) {
            await memcache.set(
              "MarketplaceService:stats:highestSale",
              saleAmount
            );
          }

          const newTotalVolume = totalVolume
            ? ethers.BigNumber.from(totalVolume)
                .add(ethers.BigNumber.from(saleAmount))
                .toString()
            : saleAmount;

          await memcache.set(
            "MarketplaceService:stats:totalVolume",
            newTotalVolume
          );
          await memcache.delete("MarketplaceService:getStats", {
            noreply: true,
          });
          break;
        }
      } catch (error) {
        // Log could not be parsed; continue to next log
        console.error(error);
      }
    }
  }

  // listing a FID
  async list({ txHash }) {
    if (!txHash) throw new Error("Missing txHash");
    const existing = await ListingLogs.findOne({ txHash });
    if (existing) {
      return await Listings.findOne({ fid: existing.fid });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().FID_MARKETPLACE_ABI
    );

    let updatedListing = null;
    for (let log of receipt.logs) {
      try {
        const parsed = eventInterface.parseLog(log);

        const fid = parsed.args.fid.toNumber();

        const query = {
          fid,
        };

        if (parsed.name === "Listed") {
          updatedListing = await Listings.findOneAndUpdate(
            query,
            {
              ownerAddress: parsed.args.owner,
              minFee: this._padWithZeros(parsed.args.amount.toString()),
              deadline: parsed.args.deadline,
              txHash, // the latest txHash
              canceledAt: null,
            },
            { upsert: true, new: true }
          );

          await ListingLogs.updateOne(
            {
              txHash,
            },
            {
              eventType: "Listed",
              fid: fid,
              from: parsed.args.owner,
              price: this._padWithZeros(parsed.args.amount.toString()),
              txHash,
            },
            {
              upsert: true,
            }
          );

          await memcache.set(`Listing:${fid}`, JSON.stringify(updatedListing));

          break;
        }
      } catch (error) {
        // Log could not be parsed; continue to next log
      }
    }
    if (!updatedListing) {
      throw new Error("FID not listed");
    }
    this.computeStats({ txHash });
    return updatedListing;
  }

  async buy({ txHash }) {
    if (!txHash) throw new Error("Missing txHash");
    const existing = await ListingLogs.findOne({ txHash });
    if (existing) {
      return await Listings.findOne({ fid: existing.fid });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().FID_MARKETPLACE_ABI
    );

    let updatedListing = null;
    let logsUpdate = null;
    for (let log of receipt.logs) {
      try {
        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "Bought") {
          const fid = parsed.args.fid.toNumber();

          const query = {
            fid,
          };

          updatedListing = await Listings.findOneAndUpdate(
            query,
            {
              txHash,
              canceledAt: new Date(),
            },
            { upsert: true, new: true }
          );

          logsUpdate = {
            eventType: "Bought",
            fid: fid,
            from: parsed.args.buyer,
            price: this._padWithZeros(parsed.args.amount.toString()),
            txHash,
          };

          await memcache.set(
            `Listing:${parsed.args.fid}`,
            JSON.stringify(updatedListing)
          );
        } else if (parsed.name === "Referred") {
          logsUpdate = {
            ...(logsUpdate || {}),
            referrer: parsed.args.referrer,
          };
        }
      } catch (error) {
        // Log could not be parsed; continue to next log
      }
    }
    if (logsUpdate) {
      await ListingLogs.updateOne(
        {
          txHash,
        },
        logsUpdate,
        {
          upsert: true,
        }
      );
    }
    if (!updatedListing) {
      throw new Error("FID not bought");
    }
    this.computeStats({ txHash });
    return updatedListing;
  }

  async offer({ txHash }) {
    if (!txHash) throw new Error("Missing txHash");
    const existing = await ListingLogs.findOne({ txHash });
    if (existing) {
      return await Offers.findOne({ txHash });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().FID_MARKETPLACE_ABI
    );

    let updatedOffer = null;

    for (let log of receipt.logs) {
      try {
        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "OfferMade") {
          const fid = parsed.args.fid.toString();

          const query = {
            fid,
            buyerAddress: parsed.args.buyer,
          };

          updatedOffer = await Offers.findOneAndUpdate(
            query,
            {
              fid,
              txHash,
              buyerAddress: parsed.args.buyer,
              amount: this._padWithZeros(parsed.args.amount.toString()),
              deadline: parsed.args.deadline,
            },
            { upsert: true, new: true }
          );

          await ListingLogs.updateOne(
            {
              txHash,
            },
            {
              eventType: "OfferMade",
              fid: fid,
              from: parsed.args.buyer,
              price: this._padWithZeros(parsed.args.amount.toString()),
              txHash,
            },
            {
              upsert: true,
            }
          );

          await memcache.delete(`getBestOffer:${parsed.args.fid}`, {
            noreply: true,
          });
          break;
        }
      } catch (error) {
        // Log could not be parsed; continue to next log
      }
    }
    if (!updatedOffer) {
      throw new Error("FID not offered");
    }
    this.computeStats({ txHash });
    return updatedOffer;
  }

  async cancelOffer({ txHash }) {
    if (!txHash) throw new Error("Missing txHash");
    const existing = await ListingLogs.findOne({ txHash });
    if (existing) {
      return await Offers.findOne({ txHash });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().FID_MARKETPLACE_ABI
    );

    let updatedOffer = null;
    for (let log of receipt.logs) {
      try {
        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "OfferCanceled") {
          const fid = parsed.args.fid.toNumber();

          const query = {
            fid,
            buyerAddress: parsed.args.buyer,
          };

          updatedOffer = await Offers.findOneAndUpdate(
            query,
            {
              fid,
              txHash,
              canceledAt: new Date(),
            },
            { upsert: true, new: true }
          );

          await ListingLogs.updateOne(
            {
              txHash,
            },
            {
              eventType: "OfferCanceled",
              fid: fid,
              from: parsed.args.buyer,
              txHash,
            },
            {
              upsert: true,
            }
          );

          await memcache.delete(`getBestOffer:${parsed.args.fid}`, {
            noreply: true,
          });
          break;
        }
      } catch (error) {
        // Log could not be parsed; continue to next log
      }
    }
    if (!updatedOffer) {
      throw new Error("FID offer not canceled");
    }
    this.computeStats({ txHash });
    return updatedOffer;
  }

  async approveOffer({ txHash }) {
    if (!txHash) throw new Error("Missing txHash");
    const existing = await ListingLogs.findOne({ txHash });
    if (existing) {
      return await Offers.findOne({ txHash });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().FID_MARKETPLACE_ABI
    );

    let updatedOffer = null;
    for (let log of receipt.logs) {
      try {
        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "OfferApproved") {
          const fid = parsed.args.fid.toNumber();

          const query = {
            fid,
            buyerAddress: parsed.args.buyer,
          };

          updatedOffer = await Offers.findOneAndUpdate(
            query,
            {
              txHash,
              canceledAt: new Date(),
            },
            { upsert: true, new: true }
          );

          await Listings.updateOne(
            {
              fid,
              canceledAt: null,
            },
            {
              canceledAt: new Date(),
            }
          );

          await ListingLogs.updateOne(
            {
              txHash,
            },
            {
              eventType: "OfferApproved",
              fid: fid,
              from: parsed.args.buyer,
              price: updatedOffer.amount,
              txHash,
            },
            {
              upsert: true,
            }
          );

          // await ListingLogs.updateOne(
          //   {
          //     txHash,
          //   },
          //   {
          //     eventType: "Canceled",
          //     fid: fid,
          //     txHash,
          //   },
          //   {
          //     upsert: true,
          //   }
          // );

          await Promise.all([
            memcache.delete(`getBestOffer:${parsed.args.fid}`, {
              noreply: true,
            }),
            memcache.delete(`Listing:${fid}`, {
              noreply: true,
            }),
          ]);
          break;
        }
      } catch (error) {
        // Log could not be parsed; continue to next log
      }
    }
    if (!updatedOffer) {
      throw new Error("FID offer not canceled");
    }
    this.computeStats({ txHash });
    return updatedOffer;
  }

  async getActivities({
    eventType,
    fid,
    from,
    collection,
    referrer,
    limit = 20,
    cursor,
  }) {
    let CACHE_KEY = `MarketplaceService:getActivities:${eventType}:${fid}:${from}:${collection}:${cursor}${limit}`;
    if (referrer) {
      CACHE_KEY = `${CACHE_KEY}:${referrer}`;
    }
    let activities;

    const data = await memcache.get(CACHE_KEY);

    if (data) {
      activities = JSON.parse(data.value).map(
        (listingLogs) => new ListingLogs(listingLogs)
      );
    }

    const [offset, lastId] = cursor ? cursor.split("-") : [Date.now(), null];

    if (!activities) {
      const query = {
        createdAt: { $lt: offset },
        id: { $lt: lastId || Number.MAX_SAFE_INTEGER },
      };

      if (eventType && eventType !== "all") {
        query.eventType = eventType;
        if (eventType === "Bought") {
          query.eventType = {
            $in: ["Bought", "OfferApproved"],
          };
        }
      }
      if (fid) {
        query.fid = fid;
      } else if (collection) {
        const filteredFid = this._getFidCollectionQuery(collection);
        if (filteredFid) {
          query.fid = filteredFid;
        }
      }

      if (from) {
        query.from = from;
      }
      if (referrer) {
        query.referrer = referrer;
      }

      activities = await ListingLogs.find(query)
        .limit(limit)
        .sort({ createdAt: -1 });
      if (cursor) {
        await memcache.set(CACHE_KEY, JSON.stringify(activities));
      } else {
        await memcache.set(CACHE_KEY, JSON.stringify(activities), {
          lifetime: 60, // 60s
        });
      }
    }

    const decorated = await Promise.all(
      activities.map(async (a) => {
        const [user, usdWei] = await Promise.all([
          this.fetchUserData(a.fid),
          this.ethToUsd(a.price),
        ]);

        const usd = this.usdFormatter.format(ethers.utils.formatEther(usdWei));

        const result = {
          ...a._doc,
          usd,
          user,
        };
        if (a.referrer) {
          result.referrerUsd = this.usdFormatter.format(
            (config().FID_MARKETPLACE_REF_PERCENTAGE *
              ethers.utils.formatEther(usdWei)) /
              100
          );
        }
        return result;
      })
    );

    let next = null;
    if (activities.length === limit) {
      next = `${activities[activities.length - 1].createdAt.getTime()}-${
        activities[activities.length - 1].id
      }`;
    }

    return [decorated, next];
  }

  async getOffers({ fid, buyerAddress, tokenId, chainId }) {
    const query = {
      canceledAt: null,
    };
    if (fid) {
      try {
        const cleanFid = parseInt(fid, 10);
        query.fid = isNaN(cleanFid) ? null : cleanFid;
      } catch (e) {
        // skip
      }
    }
    if (buyerAddress) {
      query.buyerAddress = buyerAddress;
    }
    if (tokenId) {
      // token id is in big number string format
      if (tokenId.toString().startsWith("0x")) {
        try {
          const bigIntValue = ethers.BigNumber.from(tokenId);
          tokenId = bigIntValue.toString();
        } catch (error) {
          // do nothing
        }
      }

      query.tokenId = tokenId;
    }
    if (chainId) {
      query.chainId = chainId;
    }
    // limit to 10 highest offers for now
    const offers = await Offers.find(query).sort({ amount: -1 }).limit(10);
    const decorated = await Promise.all(
      (offers || []).map(async (offer) => {
        const [user, usdWei] = await Promise.all([
          this.fetchUserData(offer.fid),
          this.ethToUsd(offer.amount),
        ]);

        const usd = this.usdFormatter.format(ethers.utils.formatEther(usdWei));

        return {
          ...offer._doc,
          usd,
          user,
        };
      })
    );
    return decorated;
  }
  async getOffer({ fid, buyerAddress }) {
    if (!fid || !buyerAddress) {
      throw new Error("Missing fid or buyerAddress");
    }
    const query = {
      canceledAt: null,
      fid,
      buyerAddress,
    };

    const offer = await Offers.findOne(query);
    return offer;
  }
  async getAppraisal({ fid }) {
    const CacheService = new _CacheService();
    const key = `MarketplaceService:appraise:${fid}`;
    const cache = await CacheService.get({
      key,
      params: {
        fid,
      },
    });
    if (cache) {
      return cache;
    }
    return {
      totalSum: ethers.utils.parseEther("0.001").toString(),
      count: 1,
      average: ethers.utils.parseEther("0.001").toString(),
    };
  }
  async appraise({ fid, appraisedBy, amount }) {
    if (!fid || !amount) {
      return;
    }
    const max = ethers.utils.parseEther("100000");
    const min = 0;
    const bigAmount = ethers.BigNumber.from(amount);
    if (bigAmount.lt(min) || bigAmount.gt(max) || bigAmount.isZero()) {
      return;
    }
    const appraisal = await Appraisals.create({
      fid: fid.toString(),
      appraisedBy,
      amount: this._padWithZeros(bigAmount.toString()),
    });

    const CacheService = new _CacheService();
    const key = `MarketplaceService:appraise:${fid}`;
    const cache = await CacheService.get({
      key,
      params: {
        fid,
      },
    });

    if (cache) {
      const value = cache;
      const totalSum = ethers.BigNumber.from(value.totalSum).add(amount);
      const count = value.count + 1;

      // For average, converting to a fixed-point representation if needed
      // Using 2 decimal places as an example
      const average = totalSum.div(count).toString();

      const newValue = {
        totalSum: totalSum.toString(),
        count,
        average: average,
      };

      await CacheService.set({
        key: key,
        params: {
          fid,
        },
        value: newValue,
      });
      return newValue;
    } else {
      // Create the cache document if it doesn't exist
      await CacheService.set({
        key: key,
        params: {
          fid,
        },
        value: {
          totalSum: amount,
          count: 1,
          average: amount,
        },
      });
      return {
        totalSum: amount,
        count: 1,
        average: amount,
      };
    }
  }

  /** NFT Marketplace */

  async listTokenId({ txHash, chainId }) {
    if (!txHash || !chainId) {
      throw new Error("Missing txHash or chainId");
    }

    chainId = parseInt(chainId);

    if (chainId !== 1 && chainId !== 10) {
      throw new Error(
        "Invalid chainId. Only 1 (Ethereum) and 10 (Optimism) are supported."
      );
    }

    const existing = await ListingLogs.findOne({ txHash, chainId });
    if (existing) {
      return await Listings.findOne({ tokenId: existing.tokenId, chainId });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().NFT_MARKETPLACE_ABI
    );

    const marketplaceAddress =
      chainId === 10
        ? config().NFT_MARKETPLACE_ADDRESS_OP
        : config().NFT_MARKETPLACE_ADDRESS_ETH;

    let updatedListing = null;
    for (let log of receipt.logs) {
      try {
        if (log.address.toLowerCase() !== marketplaceAddress.toLowerCase()) {
          continue;
        }

        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "Listed") {
          const tokenId = parsed.args.tokenId.toString();

          const query = {
            tokenId,
            chainId,
          };

          updatedListing = await Listings.findOneAndUpdate(
            query,
            {
              ownerAddress: parsed.args.owner,
              minFee: this._padWithZeros(parsed.args.price.toString()),
              deadline: parsed.args.deadline,
              txHash,
              canceledAt: null,
              tokenId,
              fid: -1,
              chainId,
            },
            { upsert: true, new: true }
          );

          await ListingLogs.updateOne(
            {
              txHash,
              chainId,
            },
            {
              eventType: "Listed",
              tokenId,
              chainId,
              fid: -1,
              from: parsed.args.owner,
              price: this._padWithZeros(parsed.args.price.toString()),
              txHash,
            },
            {
              upsert: true,
            }
          );

          await memcache.delete(`Listing:-1:${tokenId}:${chainId}`, {
            noreply: true,
          });
          break;
        }
      } catch (error) {
        console.error("Error parsing log:", error);
      }
    }
    if (!updatedListing) {
      throw new Error("Token not listed");
    }
    await this.computeStatsTokenId({ txHash, chainId });
    return updatedListing;
  }

  async buyTokenId({ txHash, chainId }) {
    if (!txHash || !chainId) throw new Error("Missing txHash or chainId");

    chainId = parseInt(chainId);

    if (chainId !== 1 && chainId !== 10) {
      throw new Error(
        "Invalid chainId. Only 1 (Ethereum) and 10 (Optimism) are supported."
      );
    }

    const existing = await ListingLogs.findOne({ txHash, chainId });
    if (existing) {
      return await Listings.findOne({ tokenId: existing.tokenId, chainId });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().NFT_MARKETPLACE_ABI
    );
    const marketplaceAddress =
      chainId === 10
        ? config().NFT_MARKETPLACE_ADDRESS_OP
        : config().NFT_MARKETPLACE_ADDRESS_ETH;

    let updatedListing = null;
    let logsUpdate = null;
    for (let log of receipt.logs) {
      try {
        if (log.address.toLowerCase() !== marketplaceAddress.toLowerCase()) {
          continue;
        }

        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "Bought") {
          const tokenId = parsed.args.tokenId.toString();

          const query = {
            tokenId,
            chainId,
          };

          updatedListing = await Listings.findOneAndUpdate(
            query,
            {
              txHash,
              canceledAt: new Date(),
            },
            { upsert: true, new: true }
          );

          logsUpdate = {
            eventType: "Bought",
            tokenId,
            chainId,
            fid: -1,
            from: parsed.args.buyer,
            price: this._padWithZeros(parsed.args.price.toString()),
            txHash,
          };

          await memcache.delete(`Listing:-1:${tokenId}:${chainId}`, {
            noreply: true,
          });
        } else if (parsed.name === "Referred") {
          logsUpdate = {
            ...(logsUpdate || {}),
            referrer: parsed.args.referrer,
          };
        }
      } catch (error) {
        console.error("Error parsing log:", error);
      }
    }
    if (logsUpdate) {
      await ListingLogs.updateOne(
        {
          txHash,
          chainId,
        },
        logsUpdate,
        {
          upsert: true,
        }
      );
    }
    if (!updatedListing) {
      throw new Error("Token not bought");
    }
    await this.computeStatsTokenId({ txHash, chainId });
    return updatedListing;
  }

  async offerTokenId({ txHash, chainId }) {
    if (!txHash || !chainId) throw new Error("Missing txHash or chainId");

    chainId = parseInt(chainId);

    if (chainId !== 1 && chainId !== 10) {
      throw new Error(
        "Invalid chainId. Only 1 (Ethereum) and 10 (Optimism) are supported."
      );
    }

    const existing = await ListingLogs.findOne({ txHash, chainId });
    if (existing) {
      return await Offers.findOne({ txHash, chainId });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().NFT_MARKETPLACE_ABI
    );
    const marketplaceAddress =
      chainId === 10
        ? config().NFT_MARKETPLACE_ADDRESS_OP
        : config().NFT_MARKETPLACE_ADDRESS_ETH;

    let updatedOffer = null;

    for (let log of receipt.logs) {
      try {
        if (log.address.toLowerCase() !== marketplaceAddress.toLowerCase()) {
          continue;
        }

        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "OfferMade") {
          const tokenId = parsed.args.tokenId.toString();

          const query = {
            tokenId,
            chainId,
            buyerAddress: parsed.args.buyer,
          };

          updatedOffer = await Offers.findOneAndUpdate(
            query,
            {
              tokenId,
              chainId,
              txHash,
              buyerAddress: parsed.args.buyer,
              amount: this._padWithZeros(parsed.args.amount.toString()),
              deadline: parsed.args.deadline,
              fid: -1,
            },
            { upsert: true, new: true }
          );

          await ListingLogs.updateOne(
            {
              txHash,
              chainId,
            },
            {
              eventType: "OfferMade",
              tokenId,
              chainId,
              fid: -1,
              from: parsed.args.buyer,
              price: this._padWithZeros(parsed.args.amount.toString()),
              txHash,
            },
            {
              upsert: true,
            }
          );

          await memcache.delete(`getBestOffer:${tokenId}:${chainId}`, {
            noreply: true,
          });
          break;
        }
      } catch (error) {
        console.error("Error parsing log:", error);
      }
    }
    if (!updatedOffer) {
      throw new Error("Token not offered");
    }
    await this.computeStatsTokenId({ txHash, chainId });
    return updatedOffer;
  }

  async cancelOfferTokenId({ txHash, chainId }) {
    if (!txHash || !chainId) throw new Error("Missing txHash or chainId");

    chainId = parseInt(chainId);

    if (chainId !== 1 && chainId !== 10) {
      throw new Error(
        "Invalid chainId. Only 1 (Ethereum) and 10 (Optimism) are supported."
      );
    }

    const existing = await ListingLogs.findOne({ txHash, chainId });
    if (existing) {
      return await Offers.findOne({ txHash, chainId });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().NFT_MARKETPLACE_ABI
    );
    const marketplaceAddress =
      chainId === 10
        ? config().NFT_MARKETPLACE_ADDRESS_OP
        : config().NFT_MARKETPLACE_ADDRESS_ETH;

    let updatedOffer = null;
    for (let log of receipt.logs) {
      try {
        if (log.address.toLowerCase() !== marketplaceAddress.toLowerCase()) {
          continue;
        }

        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "OfferCanceled") {
          const tokenId = parsed.args.tokenId.toString();

          const query = {
            tokenId,
            chainId,
            buyerAddress: parsed.args.buyer,
          };

          updatedOffer = await Offers.findOneAndUpdate(
            query,
            {
              tokenId,
              chainId,
              txHash,
              canceledAt: new Date(),
              fid: -1,
            },
            { upsert: true, new: true }
          );

          await ListingLogs.updateOne(
            {
              txHash,
              chainId,
            },
            {
              eventType: "OfferCanceled",
              tokenId,
              chainId,
              fid: -1,
              from: parsed.args.buyer,
              txHash,
            },
            {
              upsert: true,
            }
          );

          await memcache.delete(`getBestOffer:${tokenId}:${chainId}`, {
            noreply: true,
          });
          break;
        }
      } catch (error) {
        console.error("Error parsing log:", error);
      }
    }
    if (!updatedOffer) {
      throw new Error("Token offer not canceled");
    }
    await this.computeStatsTokenId({ txHash, chainId });
    return updatedOffer;
  }

  async approveOfferTokenId({ txHash, chainId }) {
    if (!txHash || !chainId) throw new Error("Missing txHash or chainId");

    chainId = parseInt(chainId);

    if (chainId !== 1 && chainId !== 10) {
      throw new Error(
        "Invalid chainId. Only 1 (Ethereum) and 10 (Optimism) are supported."
      );
    }

    const existing = await ListingLogs.findOne({ txHash, chainId });
    if (existing) {
      return await Offers.findOne({ txHash, chainId });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().NFT_MARKETPLACE_ABI
    );
    const marketplaceAddress =
      chainId === 10
        ? config().NFT_MARKETPLACE_ADDRESS_OP
        : config().NFT_MARKETPLACE_ADDRESS_ETH;

    let updatedOffer = null;
    for (let log of receipt.logs) {
      try {
        if (log.address.toLowerCase() !== marketplaceAddress.toLowerCase()) {
          continue;
        }

        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "OfferApproved") {
          const tokenId = parsed.args.tokenId.toString();

          const query = {
            tokenId,
            chainId,
            buyerAddress: parsed.args.buyer,
          };

          updatedOffer = await Offers.findOneAndUpdate(
            query,
            {
              txHash,
              canceledAt: new Date(),
              fid: -1,
            },
            { upsert: true, new: true }
          );

          await Listings.updateOne(
            {
              tokenId,
              chainId,
              canceledAt: null,
            },
            {
              canceledAt: new Date(),
            }
          );

          await ListingLogs.updateOne(
            {
              txHash,
              chainId,
            },
            {
              eventType: "OfferApproved",
              tokenId,
              chainId,
              fid: -1,
              from: parsed.args.buyer,
              price: this._padWithZeros(parsed.args.amount.toString()),
              txHash,
            },
            {
              upsert: true,
            }
          );

          await Promise.all([
            memcache.delete(`getBestOffer:${tokenId}:${chainId}`, {
              noreply: true,
            }),
            memcache.delete(`Listing:-1:${tokenId}:${chainId}`, {
              noreply: true,
            }),
          ]);
          break;
        }
      } catch (error) {
        console.error("Error parsing log:", error);
      }
    }
    if (!updatedOffer) {
      throw new Error("Token offer not approved");
    }
    await this.computeStatsTokenId({ txHash, chainId });
    return updatedOffer;
  }

  async cancelListTokenId({ txHash, chainId }) {
    if (!txHash || !chainId) {
      throw new Error("Missing txHash or chainId");
    }

    chainId = parseInt(chainId);

    if (chainId !== 1 && chainId !== 10) {
      throw new Error(
        "Invalid chainId. Only 1 (Ethereum) and 10 (Optimism) are supported."
      );
    }

    const existing = await ListingLogs.findOne({ txHash, chainId });
    if (existing) {
      return await Listings.findOne({ tokenId: existing.tokenId, chainId });
    }

    const receipt = await this.getReceipt({ txHash });
    if (!receipt) {
      throw new Error("Transaction not found");
    }

    const eventInterface = new ethers.utils.Interface(
      config().NFT_MARKETPLACE_ABI
    );
    const marketplaceAddress =
      chainId === 10
        ? config().NFT_MARKETPLACE_ADDRESS_OP
        : config().NFT_MARKETPLACE_ADDRESS_ETH;

    let updatedListing = null;
    for (let log of receipt.logs) {
      try {
        if (log.address.toLowerCase() !== marketplaceAddress.toLowerCase()) {
          continue;
        }

        const parsed = eventInterface.parseLog(log);

        if (parsed.name === "Canceled") {
          const tokenId = parsed.args.tokenId.toString();

          const query = {
            tokenId,
            chainId,
          };

          updatedListing = await Listings.findOneAndUpdate(
            query,
            {
              txHash,
              canceledAt: new Date(),
            },
            { upsert: true, new: true }
          );

          await ListingLogs.updateOne(
            {
              txHash,
              chainId,
            },
            {
              eventType: "Canceled",
              tokenId,
              chainId,
              fid: -1,
              from: parsed.args.seller,
              txHash,
            },
            {
              upsert: true,
            }
          );

          await memcache.delete(`Listing:-1:${tokenId}:${chainId}`, {
            noreply: true,
          });
          break;
        }
      } catch (error) {
        console.error("Error parsing log:", error);
      }
    }
    if (!updatedListing) {
      throw new Error("Token listing not canceled");
    }
    await this.computeStatsTokenId({ txHash, chainId });
    return updatedListing;
  }

  async getCastHandles({ sort = "createdAt", limit = 20, cursor = "" }) {
    const cacheKey = `MarketplaceService:getCastHandles:${sort}:${limit}:${cursor}`;
    const cachedData = await memcache.get(cacheKey);

    if (cachedData) {
      return JSON.parse(cachedData.value);
    }

    const [_offset, lastId] = cursor ? cursor.split("-") : [Date.now(), null];
    const offset = parseInt(_offset);

    let sortOption;
    let query = {};

    switch (sort) {
      case "fid":
        sortOption = { tokenId: 1 };
        if (lastId) query.tokenId = { $gt: lastId };
        break;
      case "-fid":
        sortOption = { tokenId: -1 };
        if (lastId) query.tokenId = { $lt: lastId };
        break;
      case "createdAt":
        sortOption = { createdAt: 1 };
        if (lastId) query.createdAt = { $gt: new Date(parseInt(lastId)) };
        break;
      case "-createdAt":
      default:
        sortOption = { createdAt: -1 };
        if (lastId) query.createdAt = { $lt: new Date(parseInt(lastId)) };
        break;
    }

    const castHandles = await CastHandle.find(query)
      .limit(limit)
      .sort(sortOption);

    const decorated = castHandles.map((handle) => ({
      listing: null,
      user: handle,
      fid: -1,
    }));

    let next = null;
    if (castHandles.length === limit) {
      const lastHandle = castHandles[castHandles.length - 1];
      next = `${offset + limit}-${
        sort.includes("fid")
          ? lastHandle.tokenId
          : lastHandle.createdAt.getTime()
      }`;
    }

    const result = [decorated, next];

    // Cache the result for 5 minutes
    await memcache.set(cacheKey, JSON.stringify(result), {
      lifetime: 5 * 60, // 5 minutes
    });

    return result;
  }

  async computeStatsTokenId({ txHash, chainId }) {
    const receipt = await this.getReceipt({ txHash });
    const eventInterface = new ethers.utils.Interface(
      config().NFT_MARKETPLACE_ABI
    );
    const marketplaceAddress =
      chainId === 10
        ? config().NFT_MARKETPLACE_ADDRESS_OP
        : config().NFT_MARKETPLACE_ADDRESS_ETH;

    for (let log of receipt.logs) {
      try {
        if (log.address.toLowerCase() !== marketplaceAddress.toLowerCase()) {
          continue;
        }

        const parsed = eventInterface.parseLog(log);
        if (parsed.name === "Listed") {
          const lastFloorRaw = await memcache.get(
            `MarketplaceService:tokenId:stats:floor:${chainId}`
          );
          const lastFloor = lastFloorRaw?.value;
          const newFloor = lastFloor
            ? ethers.BigNumber.from(parsed.args.price).lt(
                ethers.BigNumber.from(lastFloor)
              )
              ? parsed.args.price.toString()
              : lastFloor
            : parsed.args.price.toString();

          await memcache.set(
            `MarketplaceService:tokenId:stats:floor:${chainId}`,
            newFloor
          );
          break;
        } else if (
          parsed.name === "Bought" ||
          parsed.name === "OfferApproved"
        ) {
          const [highestSaleRaw, totalVolumeRaw] = await Promise.all([
            memcache.get(
              `MarketplaceService:tokenId:stats:highestSale:${chainId}`
            ),
            memcache.get(
              `MarketplaceService:tokenId:stats:totalVolume:${chainId}`
            ),
          ]);
          const highestSale = highestSaleRaw?.value;
          const totalVolume = totalVolumeRaw?.value;

          const saleAmount = parsed.args.price.toString();

          if (
            !highestSale ||
            ethers.BigNumber.from(saleAmount).gt(
              ethers.BigNumber.from(highestSale)
            )
          ) {
            await memcache.set(
              `MarketplaceService:tokenId:stats:highestSale:${chainId}`,
              saleAmount
            );
          }

          const newTotalVolume = totalVolume
            ? ethers.BigNumber.from(totalVolume)
                .add(ethers.BigNumber.from(saleAmount))
                .toString()
            : saleAmount;

          await memcache.set(
            `MarketplaceService:tokenId:stats:totalVolume:${chainId}`,
            newTotalVolume
          );
          await memcache.delete(
            `MarketplaceService:tokenId:getStats:${chainId}`,
            {
              noreply: true,
            }
          );
          break;
        }
      } catch (error) {
        console.error("Error computing stats:", error);
      }
    }
  }

  async getTokenIdStats(chainId) {
    try {
      let stats;
      const cacheKey = `MarketplaceService:tokenId:getStats:${chainId}`;

      const data = await memcache.get(cacheKey);
      if (data) {
        stats = JSON.parse(data.value);
      }

      if (!stats) {
        const [
          floorListing,
          highestOffer,
          highestSaleRaw,
          totalVolumeRaw,
          oneEthToUsd,
        ] = await Promise.all([
          Listings.findOne({ canceledAt: null, chainId }).sort({ minFee: 1 }),
          Offers.findOne({ canceledAt: null, chainId }).sort({ amount: -1 }),
          memcache.get(
            `MarketplaceService:tokenId:stats:highestSale:${chainId}`
          ),
          memcache.get(
            `MarketplaceService:tokenId:stats:totalVolume:${chainId}`
          ),
          this.ethToUsd(1),
        ]);

        const highestSale = highestSaleRaw?.value || "0";
        const totalVolume = totalVolumeRaw?.value || "0";

        stats = {
          stats: {
            floor: {
              usd: this.usdFormatter.format(
                ethers.utils.formatEther(
                  ethers.BigNumber.from(floorListing?.minFee || "0").mul(
                    oneEthToUsd
                  )
                )
              ),
              wei: floorListing?.minFee || "0",
            },
            highestOffer: {
              usd: this.usdFormatter.format(
                ethers.utils.formatEther(
                  ethers.BigNumber.from(highestOffer?.amount || "0").mul(
                    oneEthToUsd
                  )
                )
              ),
              wei: highestOffer?.amount || "0",
            },
            highestSale: {
              usd: this.usdFormatter.format(
                ethers.utils.formatEther(
                  ethers.BigNumber.from(highestSale).mul(oneEthToUsd)
                )
              ),
              wei: highestSale,
            },
            totalVolume: {
              usd: this.usdFormatter.format(
                ethers.utils.formatEther(
                  ethers.BigNumber.from(totalVolume).mul(oneEthToUsd)
                )
              ),
              wei: totalVolume,
            },
          },
          success: true,
        };

        await memcache.set(cacheKey, JSON.stringify(stats), {
          lifetime: 60 * 5, // 5 minutes cache
        });
      }

      return stats;
    } catch (e) {
      console.error(e);
      Sentry.captureException(e);
      return {
        success: false,
        stats: {},
      };
    }
  }

  async getHistoricalSales({ fid, tokenId, chainId, timerange = "30d" }) {
    const query = {};
    if (fid) query.fid = fid;
    if (tokenId) query.tokenId = tokenId;
    if (chainId) query.chainId = chainId;

    // Calculate the start date based on the timerange
    const endDate = new Date();
    const startDate = new Date(endDate);
    const [amount, unit] = timerange.match(/(\d+)(\w)/).slice(1);
    switch (unit) {
      case "d":
        startDate.setDate(endDate.getDate() - parseInt(amount));
        break;
      case "w":
        startDate.setDate(endDate.getDate() - parseInt(amount) * 7);
        break;
      case "m":
        startDate.setMonth(endDate.getMonth() - parseInt(amount));
        break;
      case "y":
        startDate.setFullYear(endDate.getFullYear() - parseInt(amount));
        break;
      default:
        throw new Error("Invalid timerange format");
    }

    query.createdAt = { $gte: startDate, $lte: endDate };
    query.eventType = { $in: ["Bought", "OfferApproved"] };

    // Use Promise.all to fetch sales and ETH to USD rate concurrently
    const [sales, oneEthToUsd] = await Promise.all([
      ListingLogs.find(query).sort({ createdAt: 1 }),
      this.ethToUsd(1),
    ]);

    // Group sales by day and calculate the total for each day
    const dailySales = sales.reduce((acc, sale) => {
      const date = sale.createdAt.toISOString().split("T")[0];
      if (!acc[date]) {
        acc[date] = { timestamp: new Date(date).getTime(), count: 0 };
      }
      const saleAmountUsd = parseFloat(
        ethers.utils.formatEther(
          ethers.BigNumber.from(sale.price).mul(oneEthToUsd)
        )
      );
      acc[date].count += saleAmountUsd;
      return acc;
    }, {});

    // Convert the grouped data to an array and sort by timestamp
    const result = Object.values(dailySales).sort(
      (a, b) => a.timestamp - b.timestamp
    );

    return result;
  }
}

module.exports = { Service: MarketplaceService };
