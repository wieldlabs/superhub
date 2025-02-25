const { Service: _CacheService } = require("./cache/CacheService");
const fido2 = require("fido2-lib");
const base64url = require("base64url");
const ethers = require("ethers");
const {
  abi: keyRegistrarAbi,
  address: keyRegistrarAddress,
  gateway_address: keyGatewayAddress,
  gateway_registry_address: keyGatewayRegistryAddress,
} = require("../helpers/abi/key-registrar");
const {
  abi: idRegistrarAbi,
  address: idRegistrarAddress,
  gateway_registry_address: idGatewayRegistryAddress,
} = require("../helpers/abi/id-registrar");
const { getProvider } = require("../helpers/alchemy-provider");
const { Alchemy, Network, Utils } = require("alchemy-sdk");
const { memcache } = require("../connectmemcache");
const crypto = require("crypto");

const flagsDev = () => {
  return {
    USE_GATEWAYS: true,
  };
};

const flagsProd = () => {
  return {
    USE_GATEWAYS: true,
  };
};

const getFlags = () =>
  process.env.NODE_ENV === "production" ? flagsProd() : flagsDev();

/**
 * Generate a random base64 string as a challenge
 * at least 32 bytes
 * @returns String
 */
const generateChallenge = () => {
  return crypto.randomBytes(32).toString("base64");
};

class AccountRecovererService {
  _accepableRecovererTypes = [
    "PASSKEY",
    "FARCASTER_SIGNER",
    "FARCASTER_SIGNER_EXTERNAL",
  ];

  _bufferToAB(buf) {
    var ab = new ArrayBuffer(buf.length);
    var view = new Uint8Array(ab);
    for (var i = 0; i < buf.length; ++i) {
      view[i] = buf[i];
    }
    return ab;
  }
  async _verifyAttestationResponse({ signature, challenge }) {
    try {
      const body = JSON.parse(signature);
      const clientDataJSON = body.response.clientDataJSON;
      const attestationObject = body.response.attestationObject;
      const idArrayBuffer = this.bufferToAB(base64url.toBuffer(body.id));
      const { id, type } = body;

      /** step1: verify with address */
      if (type !== "public-key") {
        throw new Error("Invalid PassKey type");
      }

      const f2l = new fido2.Fido2Lib({
        timeout: 60000,
        challengeSize: 52,
        rpId: process.env.NODE_ENV === "production" ? "Wield" : "localhost",
        rpName: "Wield", // replace with your application's name
      });
      const attestationExpectations = {
        challenge,
        origin:
          process.env.NODE_ENV === "production"
            ? "https://wield.xyz"
            : "http://localhost:5678",
        factor: "either",
      };

      /** step2: verify with Fido2Lib the attestation is valid */
      let authnResult = await f2l.attestationResult(
        {
          rawId: idArrayBuffer,
          id: idArrayBuffer,
          response: {
            ...body.response,
            attestationObject: attestationObject,
            clientDataJSON: clientDataJSON,
          },
        },
        attestationExpectations
      );
      return { ...authnResult, id };
    } catch (e) {
      console.error(e);
      throw new Error("Could not parse PassKey signature");
    }
  }
  /**
   * Add a Passkey recoverer to an account
   * @param {Account} account
   * @returns Promise<AccountRecoverer>
   */
  async _addPasskeyRecoverer(account, { signature }) {
    const CacheService = new _CacheService();
    const initialChallenge = await CacheService.get({
      key: "ChallengeForRecoverer",
      params: {
        accountId: account._id,
        type: "PASSKEY",
      },
    });
    if (!initialChallenge) throw new Error("No challenge found");
    const authnResult = await this._verifyAttestationResponse({
      signature,
      challenge: initialChallenge,
    });
    const pubKey = authnResult.authnrData.get("credentialPublicKeyPem");
    const counter = authnResult.authnrData.get("counter");
    const passkeyId = authnResult.authnrData.get("id");
    // create a new challenge for subsequent recoverer login. Should expire in 7 days.
    const challenge = {
      challenge: generateChallenge(),
    };
    return {
      type: "PASSKEY",
      id: passkeyId,
      pubKey,
      counter,
      challenge,
    };
  }

  /**
   * Add a Farcaster signer recoverer to an account
   * @param {Account} account
   * @returns Promise<AccountRecoverer>
   */
  async _addFarcasterSignerRecoverer(account, { address, id, type }) {
    return {
      type,
      id: id.toString(),
      pubKey: address?.toLowerCase?.(),
    };
  }

  /**
   * Verify an address is a signer to a fid
   * @param {Account} account
   * @param {String} address signer address or key
   * @param {String} fid FID to verify
   * @returns Promise<Boolean>
   */
  async verifyFarcasterSignerAndGetFid(
    _,
    { signerAddress, custodyAddress, fid: givenFid }
  ) {
    const alchemyProvider = getProvider({
      network: 10,
      node: process.env.OPTIMISM_NODE_URL,
    });

    const flags = getFlags();
    const keyAddress = flags.USE_GATEWAYS
      ? keyGatewayRegistryAddress
      : keyRegistrarAddress;
    const idAddress = flags.USE_GATEWAYS
      ? idGatewayRegistryAddress
      : idRegistrarAddress;

    const keyRegistrar = new ethers.Contract(
      keyAddress,
      keyRegistrarAbi,
      alchemyProvider
    );
    const idRegistrar = new ethers.Contract(
      idAddress,
      idRegistrarAbi,
      alchemyProvider
    );

    let fid = givenFid;
    if (!fid) {
      fid = await idRegistrar.idOf(custodyAddress);
      if (!fid) {
        throw new Error("Address does not own a valid FID");
      }
    }
    const exist = await keyRegistrar.keyDataOf(fid, signerAddress);

    // state 1 = added, 0 = not added, 2 = removed
    return exist?.state === 1 ? fid : null;
  }

  async getFid(_, { custodyAddress }) {
    const alchemyProvider = getProvider({
      network: 10,
      node: process.env.OPTIMISM_NODE_URL,
    });

    const idAddress = idGatewayRegistryAddress;

    const idRegistrar = new ethers.Contract(
      idAddress,
      idRegistrarAbi,
      alchemyProvider
    );

    const fid = await idRegistrar.idOf(custodyAddress);
    return fid;
  }

  // add a signer to a fid, or get the signer if the signer is already added
  // @returns {String} signerAddress
  async addOrGetSigner(
    _,
    {
      signerAddress,
      fid,
      custodyAddress,
      signature: fidSignature,
      deadline,
      metadata,
    }
  ) {
    const alchemyProvider = getProvider({
      network: 10,
      node: process.env.OPTIMISM_NODE_URL,
    });
    const alchemy = new Alchemy({
      apiKey: process.env.OPTIMISM_NODE_URL,
      network: Network.OPT_MAINNET,
    });
    const currentGasInHex = (await alchemy.core.getGasPrice())
      .mul(110)
      .div(100); // Add 10% to the currentGas (5% might still be slow)
    const currentGasInWeiString = Utils.formatUnits(currentGasInHex, "gwei");
    const currentGasInWei = ethers.utils.parseUnits(
      currentGasInWeiString,
      "gwei"
    );
    const MAX_GAS = ethers.utils.parseUnits("0.5", "gwei");
    if (currentGasInWei.gt(MAX_GAS)) {
      throw new Error(`Gas price is too high: ${currentGasInWeiString} gwei`);
    }

    const mnemonic = process.env.FARCAST_KEY;
    if (!mnemonic) {
      throw new Error("Not configured!");
    }
    const wallet = ethers.Wallet.fromMnemonic(mnemonic);
    const signer = wallet.connect(alchemyProvider);

    const keyRegistrar = new ethers.Contract(
      keyGatewayRegistryAddress,
      keyRegistrarAbi,
      signer
    );

    const keyGateway = new ethers.Contract(
      keyGatewayAddress,
      keyRegistrarAbi, // this abi has both keyRegistry and keyGateway methods
      signer
    );

    const key = signerAddress;
    const exist = await keyRegistrar.keyDataOf(fid, key);
    // state 1 = added, 0 = not added, 2 = removed
    if (exist?.state === 1) {
      return signerAddress;
    } else if (exist?.state === 0) {
      const keyType = 1; // 1 = ed25519
      const metadataType = 1; // 1 = text

      //  inputs: [
      //   { internalType: "address", name: "fidOwner", type: "address" },
      //   { internalType: "uint32", name: "keyType", type: "uint32" },
      //   { internalType: "bytes", name: "key", type: "bytes" },
      //   { internalType: "uint8", name: "metadataType", type: "uint8" },
      //   { internalType: "bytes", name: "metadata", type: "bytes" },
      //   { internalType: "uint256", name: "deadline", type: "uint256" },
      //   { internalType: "bytes", name: "sig", type: "bytes" },
      // ]
      console.log({
        custodyAddress,
        keyType,
        key,
        metadataType,
        metadata,
        deadline,
        fidSignature,
      });
      const CacheService = new _CacheService();
      const signedAddedToday = await CacheService.get({
        key: `AccountRecovererService:addOrGetSigner:V2`,
        params: { custodyAddress },
      });
      let signedAddedTodayCount = 1;
      if (signedAddedToday) {
        signedAddedTodayCount = parseInt(signedAddedToday);
        if (signedAddedTodayCount >= 5) {
          throw new Error(
            "You've added 5 signers in 6 hours. Please wait 6 hours and try again."
          );
        }
        signedAddedTodayCount++;
      }
      await CacheService.set({
        key: `AccountRecovererService:addOrGetSigner:V2`,
        params: { custodyAddress },
        value: signedAddedTodayCount,
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000), // 6 hours from now
      });

      const tx = await keyGateway.addFor(
        custodyAddress,
        keyType,
        key,
        metadataType,
        metadata,
        ethers.BigNumber.from(deadline),
        fidSignature,
        {
          // Settings from: https://optimistic.etherscan.io/tx/0x3df5c4dc38ef2da3b292dba30531c3470e291acd47039cc255b8d1c03883aeab
          gasLimit: 250_000,
          // this needs to be dynamic, make sure it's under 1-2 cents
          maxFeePerGas: currentGasInWei,
          maxPriorityFeePerGas: currentGasInWei,
        }
      );

      await tx.wait();
      console.log("Added Signer");
      console.log({
        hash: tx.hash,
        signerAddress,
        fid,
        custodyAddress,
      });
      return signerAddress;
    } else {
      throw new Error("Signer has been removed");
    }
  }

  /**
   * Verify Get all signers to a fid
   * @param {uint258} state 1 = added, 0 = not added, 2 = removed
   * @param {String} fid FID to verify
   * @returns Promise<bytes[]>
   */
  async getSigners(_, { fid, state = 1 }) {
    // @TODO add memcache back when we know how to invalidate
    // try {
    //   const data = await memcache.get(
    //     `AccountRecovererService:getSigners:${fid}:${state}`
    //   );

    //   if (data) {
    //     return JSON.parse(data.value);
    //   }
    // } catch (e) {
    //   console.error(e);
    // }

    const alchemyProvider = getProvider({
      network: 10,
      node: process.env.OPTIMISM_NODE_URL,
    });

    const flags = getFlags();
    const keyAddress = flags.USE_GATEWAYS
      ? keyGatewayRegistryAddress
      : keyRegistrarAddress;
    const keyRegistrar = new ethers.Contract(
      keyAddress,
      keyRegistrarAbi,
      alchemyProvider
    );

    const keys = await keyRegistrar.keysOf(fid, state);
    //   await memcache.set(
    //     `AccountRecovererService:getSigners:${fid}:${state}`,
    //     JSON.stringify(keys),
    //     {
    //       lifetime: 60 * 60, // 1 hour cache
    //     }
    //   );

    // state 1 = added, 0 = not added, 2 = removed
    return keys;
  }

  /**
   * Generate a short lived challenge in cache, which is used to initiate the recoverer
   * @param {Account} account
   * @returns Promise<String> challenge
   */
  async requestInitialChallengeForRecoverer(account, { type }) {
    if (!account) throw new Error("Account not found");
    // only support passkey for now
    if (type !== "PASSKEY") throw new Error("Invalid recoverer type");
    const CacheService = new _CacheService();
    // 10 minutes from now
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const challenge = generateChallenge();
    await CacheService.set({
      key: "ChallengeForRecoverer",
      params: {
        accountId: account._id,
        type,
      },
      value: challenge,
      expiresAt,
    });
    return challenge;
  }

  /**
   * Add a recoverer to an account
   * @param {Account} account
   * @returns Promise<Account>
   */
  async addRecoverer(account, { signature, type, address, id }) {
    if (!account) throw new Error("Account not found");

    if (this._accepableRecovererTypes.indexOf(type) === -1) {
      throw new Error("Invalid recoverer type");
    }
    try {
      let recoverer;
      if (type === "PASSKEY") {
        recoverer = await this._addPasskeyRecoverer(account, { signature });
      } else if (
        type === "FARCASTER_SIGNER" ||
        type === "FARCASTER_SIGNER_EXTERNAL"
      ) {
        recoverer = await this._addFarcasterSignerRecoverer(account, {
          address,
          id,
          type,
        });
      }

      if (account.recoverers) {
        // dedupe
        if (
          account.recoverers.find(
            (r) => r.id === recoverer.id && r.pubKey === recoverer.pubKey
          )
        ) {
          return account;
        }
        account.recoverers.push(recoverer);
      } else {
        account.recoverers = [recoverer];
      }
      const updatedAccount = await account.save();
      await Promise.all([
        memcache.delete(`Account:findById:${account._id}`),
        memcache.delete(
          `FarcasterHubService:getFidByAccountId:${account._id}:false`
        ),
        memcache.delete(
          `FarcasterHubService:getFidByAccountId:${account._id}:true`
        ),
      ]);
      return updatedAccount;
    } catch (e) {
      console.error(e);
      throw new Error("Could not add recoverer: " + e.message);
    }
  }
}

module.exports = { Service: AccountRecovererService };
