const app = require("express").Router();
const Sentry = require("@sentry/node");
const { ApiKey } = require("../models/ApiKey");
const { memcache, getHash } = require("../connectmemcache");
const rateLimit = require("express-rate-limit");

const heavyLimiter = rateLimit({
  windowMs: 60_000,
  max: 1,
  message: "Too many requests! See docs.wield.xyz for more info.",
  validate: { limit: false },
});

const generateKey = () => {
  let code = "";
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  for (let i = 1; i <= 25; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    code += characters[randomIndex];

    if (i % 5 === 0 && i < 25) {
      code += "-";
    }
  }

  return code;
};

app.post("/create", heavyLimiter, async (req, res) => {
  try {
    const { description, email } = req.body;

    const isValidEmail = (email) => {
      const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      return re.test(email);
    };

    if (!isValidEmail(email)) {
      return res.json({
        code: "400",
        success: false,
        message: "Invalid email address!",
      });
    }

    if (!description || description.length < 5) {
      return res.json({
        code: "400",
        success: false,
        message: "Description must be longer than 5 characters",
      });
    }

    const apiKey = await ApiKey.create({
      description,
      email,
      multiplier: 1,
      key: generateKey(),
    });

    Sentry.captureMessage(
      `New API key created for ${apiKey.email} with "${apiKey.description}".`
    );

    return res.json({
      code: "201",
      success: true,
      message: "Successfully created API key!",
      key: apiKey.key,
    });
  } catch (e) {
    Sentry.captureException(e);
    console.error(e);
    return res.json({
      code: "500",
      success: false,
      message: "Internal server error!",
    });
  }
});

const apiKeyCache = new Map(); // two layers of cache, in memory and memcache
const getLimit = (baseMultiplier) => {
  // query ApiKeys to get the multiplier and return the multiplier * baseMultiplier or 0
  return async (req, _res) => {
    const key = req.header("API-KEY");
    if (!key) {
      const err = `Missing API-KEY header! Returning 0`;
      Sentry.captureMessage(err, {
        tags: {
          url: req.url,
        },
      });
      return 0;
    }
    let apiKey;

    if (apiKeyCache.has(key)) {
      apiKey = apiKeyCache.get(key);
    } else {
      const data = await memcache.get(
        getHash(`FarcasterApiKey_checkLimit:${key}`)
      );
      if (data) {
        apiKey = new ApiKey(JSON.parse(data.value));
        apiKeyCache.set(key, apiKey);
      }
    }

    if (!apiKey) {
      apiKey = await ApiKey.findOne({ key });
      if (apiKey) {
        apiKeyCache.set(key, apiKey);
        await memcache.set(
          getHash(`FarcasterApiKey_checkLimit:${key}`),
          JSON.stringify(apiKey),
          { lifetime: 60 * 60 } // 1 hour
        );
      }
    }

    if (!apiKey) {
      const err = `API-KEY ${key} not found! Returning 0 for ${req.url}`;
      console.error(err);
      Sentry.captureMessage(err);
      return 0;
    }

    return Math.ceil(baseMultiplier * apiKey.multiplier);
  };
};

module.exports = {
  router: app,
  getLimit,
};
