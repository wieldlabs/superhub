const mongoose = require("mongoose");
// https://mongoosejs.com/docs/advanced_schemas.html
const crypto = require("crypto");
const { ethers } = require("ethers");
const { recoverPersonalSignature } = require("@metamask/eth-sig-util");
const { bufferToHex } = require("ethereumjs-util");

const { getRandomUint256 } = require("../helpers/get-random-uint256");

const { schema } = require("../schemas/accountNonce");

class AccountNonceClass {
  static ping() {
    console.log("model: AccountNonceClass");
  }

  async getMessageToSign() {
    const msg = `@wieldlabs/superhub wants you to sign in with your Ethereum account, secured with a signed message:\n ${this.nonce.length} ${this.nonce}`;
    return msg;
  }

  async decodeAddressBySignature(signature) {
    const msg = `@wieldlabs/superhub wants you to sign in with your Ethereum account, secured with a signed message:\n ${this.nonce.length} ${this.nonce}`;
    const msgBufferHex = bufferToHex(Buffer.from(msg, "utf8"));
    const address = recoverPersonalSignature({
      data: msgBufferHex,
      signature,
    });
    return address;
  }

  /**
   * Generate a new transaction nonce for accountId
   * @returns Promise<AccountNonce>
   */
  static async generateNewTransactionNonceByAccountId(accountId) {
    const accountNonce = await this.findOne({ account: accountId });
    if (!accountNonce) throw new Error("Invalid account nonce");
    accountNonce.generateNewTransactionNonce();
    return accountNonce;
  }

  /** generate a new account nonce */
  async generateNewNonce() {
    this.nonce = `${crypto.randomInt(1, 10000)}`;
    await this.save();
  }

  /** generate a new account transaction nonce */
  async generateNewTransactionNonce() {
    this.transactionNonce = `${getRandomUint256()}`;
    await this.save();
  }

  /**
   * Get the default AccountAddress mongo _id
   * @returns string
   */
  get salt() {
    let bytes = ethers.utils.toUtf8Bytes(this._id);
    let hash = ethers.utils.keccak256(bytes);
    // Use the entire hash to create a 256-bit salt.
    let salt = ethers.BigNumber.from(hash);
    return salt.toString();
  }
}

schema.loadClass(AccountNonceClass);

const AccountNonce =
  mongoose.models.AccountNonce || mongoose.model("AccountNonce", schema);

module.exports = {
  AccountNonce,
};
