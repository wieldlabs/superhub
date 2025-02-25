const { MemcacheClient } = require("memcache-client");
const crypto = require("crypto");

function _validateKey(key) {
  if (typeof key !== "string") {
    throw new Error(`Key must be a string: '${key}'`);
  }
  if (key.length > 250) {
    throw new Error(`Key must be less than 250 characters: '${key}'`);
  }
  if (key.includes(" ")) {
    throw new Error(`Key must not include space: '${key}'`);
  }
}

function _validateValue(value) {
  if (typeof value === "string") {
    if (value.length > 1000000) {
      throw new Error(
        `Value must be less than 1MB: '${value.substring(0, 200)}'`
      );
    }
  }
}

///
// SafeMemcacheClient is a wrapper around the MemcacheClient that handles errors and exceptions
// By default, we handle exceptions by logging the error and returning null
// If you want to throw the exception, you can pass `throwExceptions: true` to the method
///
class SafeMemcacheClient {
  getClient() {
    this._client ||= new MemcacheClient({
      server: {
        server: process.env.MEMCACHED_URL || "localhost:11211",
        maxConnections: 250, // With low maxConnections, we start getting `CLIENT_ERROR bad command line format` errors
      },
    });
    return this._client;
  }

  async get(key, options = null, overrides = {}) {
    const client = this.getClient();
    try {
      _validateKey(key);
      return await client.get(key, options);
    } catch (e) {
      console.error(e);
      if (overrides.throwExceptions) {
        throw e;
      }
      return null;
    }
  }

  async set(key, value, options = null, overrides = {}) {
    const client = this.getClient();
    try {
      _validateKey(key);
      _validateValue(value);
      return await client.set(key, value, options);
    } catch (e) {
      console.error(e);
      if (overrides.throwExceptions) {
        throw e;
      }
      return null;
    }
  }

  async delete(key, options = null, overrides = {}) {
    const client = this.getClient();
    try {
      _validateKey(key);
      return await client.delete(key, options);
    } catch (e) {
      console.error(e);
      if (overrides.throwExceptions) {
        throw e;
      }
      return null;
    }
  }

  async incr(key, value, options = null, overrides = {}) {
    const client = this.getClient();
    try {
      _validateKey(key);
      return await client.incr(key, value, options);
    } catch (e) {
      console.error(e);
      if (overrides.throwExceptions) {
        throw e;
      }
      return null;
    }
  }

  async decr(key, value, options = null, overrides = {}) {
    const client = this.getClient();
    try {
      _validateKey(key);
      return await client.decr(key, value, options);
    } catch (e) {
      console.error(e);
      if (overrides.throwExceptions) {
        throw e;
      }
      return null;
    }
  }
}

let client;

module.exports = {
  memcache: new SafeMemcacheClient(),
  getHash: (key) => {
    return crypto.createHash("sha256").update(key).digest("hex");
  },
};
